import { creditGameReward } from './game-payout';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RngService } from './rng.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { rollDice, isWinningNumber, computeSumDiceReward, DiceConfig } from './sum-dice-rules';
import { WalletType, LedgerEntryType } from '@prisma/client';

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

    await this.prisma.gameRound.update({ where: { id: roundId }, data: { status: 'RESOLVING' } });

    const game = await this.prisma.gameDefinition.findUnique({ where: { code: round.gameCode } });
    const rules = (game?.rulesJson as any) ?? {};
    const payoutMultiplier = rules.payoutMultiplier ?? 20;
    const isSumDice = round.selectionCount == null && !!rules.diceCount && !!rules.diceSides;

    const drawResult = isSumDice
      ? rollDice({ diceCount: rules.diceCount, diceSides: rules.diceSides } as DiceConfig, () =>
          this.rng.randomInRange(0, rules.diceSides - 1),
        )
      : { dice: this.generateResult(round), sum: null as number | null };

    const entries = await this.prisma.gameEntry.findMany({ where: { roundId } });

    for (const entry of entries) {
      let won: boolean;
      let rewardAmount: number;

      if (isSumDice) {
        won = isWinningNumber(entry.selection as number[], drawResult.sum!);
        rewardAmount = computeSumDiceReward(
          entry.coinAmount,
          (entry.selection as number[]).length,
          payoutMultiplier,
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

  private generateResult(round: { numberRange: number | null; selectionCount: number | null }): number[] {
    if (round.numberRange && round.selectionCount) {
      const drawn = new Set<number>();
      while (drawn.size < round.selectionCount) {
        drawn.add(this.rng.randomInRange(1, round.numberRange));
      }
      return Array.from(drawn);
    }
    return [];
  }
}
