import { creditGameReward } from './game-payout';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RngService } from './rng.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { isWinningNumber, computeSumDiceReward, DiceConfig } from './sum-dice-rules';
import { WalletType, LedgerEntryType } from '@prisma/client';
import { buildRoundData } from './game-fairness';

// Pure and exported specifically so it's unit-testable without a database —
// this is the line between "you won" and "you didn't" for real money, so it
// gets tested directly rather than only indirectly through settle().
// Lucky-Number-shaped only (exact full-set match) — sum-dice's win check is
// isWinningNumber in sum-dice-rules.ts, kept separate since the two games'
// win conditions aren't the same shape (exact-set-match vs. "is my number
// among several I picked").
export function isWinningSelection(selection: unknown, result: number[]): boolean {
  if (!Array.isArray(selection)) return false;
  const sortedSelection = [...selection].sort();
  const sortedResult = [...result].sort();
  return sortedSelection.length === sortedResult.length && sortedSelection.every((n, i) => n === sortedResult[i]);
}

@Injectable()
export class SettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly rng: RngService,
  ) {}

  async settle(roundId: string) {
    const round = await this.prisma.gameRound.findUnique({ where: { id: roundId } });
    if (!round) throw new NotFoundException('Round not found');
    if (round.status === 'SETTLED') return round; // idempotent — settlement never runs twice
    if (round.status !== 'LOCKED') throw new BadRequestException('Round must be LOCKED before settling');

    // Atomic claim: the queue worker and the round scheduler can both reach
    // this point for the same round (and so could a second server instance).
    // Only the caller that actually moves LOCKED -> RESOLVING may draw the
    // result and pay out; anyone else must not, or the round would be drawn
    // and paid twice with different results.
    const claimed = await this.prisma.gameRound.updateMany({ where: { id: roundId, status: 'LOCKED' }, data: { status: 'RESOLVING' } });
    if (claimed.count === 0) return this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });

    const game = await this.prisma.gameDefinition.findUnique({ where: { code: round.gameCode } });
    const rules = (game?.rulesJson as any) ?? {};
    const payoutMultiplier = rules.payoutMultiplier ?? 20;
    const isSumDice = round.selectionCount == null && !!rules.diceCount && !!rules.diceSides;

    const roundData = buildRoundData(round);
    const secret = round.revealData;
    if (!secret) throw new BadRequestException('Round has no fairness secret');

    const drawResult = isSumDice
      ? (() => {
          const config = { diceCount: rules.diceCount, diceSides: rules.diceSides } as DiceConfig;
          const dice = Array.from({ length: config.diceCount }, (_, index) =>
            this.rng.randomInRangeFromSecret(secret, `dice:${roundData}:${index}`, 0, config.diceSides - 1),
          );
          return { dice, sum: dice.reduce((a, b) => a + b, 0) };
        })()
      : { dice: this.generateResult(round, secret, roundData), sum: null as number | null };

    // Only live entries: anything already refunded/settled must never be paid again.
    const entries = await this.prisma.gameEntry.findMany({ where: { roundId, status: 'PLACED' } });

    for (const entry of entries) {
      let won: boolean;
      let rewardAmount: number;

      if (isSumDice) {
        won = isWinningNumber(entry.selection as number[], drawResult.sum!);
        const selected = entry.selection as number[];
        const winningMultiplier = rules.numberPayouts && typeof rules.numberPayouts === 'object'
          ? Number((rules.numberPayouts as Record<string, unknown>)[String(drawResult.sum!) ] ?? 0)
          : payoutMultiplier;
        rewardAmount = computeSumDiceReward(
          entry.coinAmount,
          selected.length,
          winningMultiplier,
          won,
        );
      } else {
        won = isWinningSelection(entry.selection, drawResult.dice);
        rewardAmount = won ? entry.coinAmount * payoutMultiplier : 0;
      }

      // Same per-entry atomicity fix as CrashService.settleCrash() — credit
      // and the WON/LOST status update commit together, so a failure in
      // the status update after a successful credit can't leave a paid
      // entry stuck at PLACED. A loss (no credit at all) is a single write
      // and doesn't need the transaction wrapper.
      if (won && rewardAmount > 0) {
        await this.prisma.$transaction(async (tx) => {
          await creditGameReward(
            this.wallet,
            { userId: entry.userId, reward: rewardAmount, coinAmount: entry.coinAmount, bonusAmount: entry.bonusAmount, entryId: entry.id },
            tx,
          );
          return tx.gameEntry.update({
            where: { id: entry.id },
            data: { status: 'WON', rewardAmount },
          });
        }, EXTENDED_TX_OPTIONS);
      } else {
        await this.prisma.gameEntry.update({
          where: { id: entry.id },
          data: { status: 'LOST', rewardAmount: 0 },
        });
      }
    }

    // Result is written once, here, and the round moves to a terminal
    // state — nothing else in the codebase updates GameRound.result or
    // flips a SETTLED round back open. An admin "correct a past result"
    // path is explicitly out of scope (spec §94: "admins can silently
    // change historical game results" is a listed non-negotiable to avoid).
    // Sum-dice stores {dice, sum} so a player can see the individual dice
    // that produced the winning number, not just the number itself.
    const storedResult = isSumDice ? { dice: drawResult.dice, sum: drawResult.sum } : drawResult.dice;

    return this.prisma.gameRound.update({
      where: { id: roundId },
      data: { status: 'SETTLED', result: storedResult as any, settledAt: new Date() },
    });
  }

  // Cancels a round that was left unfinished by an outage and gives every
  // player their stake back. Used by the round scheduler only for rounds that
  // are far overdue (see round-recovery.ts): settling them now would decide
  // money outcomes long after players saw the round, and for Crash the players
  // could not have cashed out in time.
  //
  // The round is claimed first (SCHEDULED/OPEN/LOCKED -> RESOLVING) so it can
  // never be settled and refunded at the same time. Each refund is one
  // transaction (credit + REFUNDED status) and is idempotent on the entry, so if
  // this stops halfway, running it again pays nobody twice. If it does stop
  // halfway the round stays RESOLVING rather than CANCELLED, which is what the
  // scheduler reports on.
  async voidRound(roundId: string): Promise<{ refunded: number }> {
    const claimed = await this.prisma.gameRound.updateMany({
      where: { id: roundId, status: { in: ['SCHEDULED', 'OPEN', 'LOCKED'] } },
      data: { status: 'RESOLVING' },
    });
    if (claimed.count === 0) return { refunded: 0 };

    const entries = await this.prisma.gameEntry.findMany({ where: { roundId, status: 'PLACED' } });
    let refunded = 0;
    for (const entry of entries) {
      // What was staked from bonus coins goes back to the bonus wallet, so a
      // refund can never turn free-play credit into spendable coins.
      const bonus = Math.min(entry.bonusAmount, entry.coinAmount);
      const coin = entry.coinAmount - bonus;
      await this.prisma.$transaction(async (tx) => {
        if (coin > 0) {
          await this.wallet.credit(
            { userId: entry.userId, walletType: WalletType.COIN, amount: BigInt(coin), ledgerType: LedgerEntryType.REFUND, reference: entry.id, idempotencyKey: `game_refund:${entry.id}` },
            tx,
          );
        }
        if (bonus > 0) {
          await this.wallet.credit(
            { userId: entry.userId, walletType: WalletType.BONUS, amount: BigInt(bonus), ledgerType: LedgerEntryType.REFUND, reference: entry.id, idempotencyKey: `game_refund_bonus:${entry.id}` },
            tx,
          );
        }
        await tx.gameEntry.update({ where: { id: entry.id }, data: { status: 'REFUNDED', rewardAmount: 0 } });
      }, EXTENDED_TX_OPTIONS);
      refunded++;
    }

    await this.prisma.gameRound.update({ where: { id: roundId }, data: { status: 'CANCELLED' } });
    return { refunded };
  }

  private generateResult(
    round: { gameCode: string; openAt: Date; lockAt: Date; numberRange: number | null; selectionCount: number | null },
    secret: string,
    roundData: string,
  ): number[] {
    if (round.numberRange && round.selectionCount) {
      const drawn = new Set<number>();
      let index = 0;
      while (drawn.size < round.selectionCount) {
        drawn.add(this.rng.randomInRangeFromSecret(secret, `pick:${roundData}:${index++}`, 1, round.numberRange));
      }
      return Array.from(drawn);
    }
    return [];
  }
}
