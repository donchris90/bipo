import { creditGameReward } from './game-payout';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RngService } from './rng.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import {
  generateCrashPoint,
  currentMultiplier,
  crashTimeSeconds,
  resolveCashout,
  resolveAutoCashout,
  computeCrashReward,
} from './crash-rules';
import { WalletType, LedgerEntryType } from '@prisma/client';

export interface CrashStatusView {
  status: 'SCHEDULED' | 'OPEN' | 'LIVE' | 'CRASHED';
  multiplier: number | null;
  // While LIVE: how the app can draw the flight between checks.
  growthRate?: number;
  elapsedMs?: number;
  // The server's clock when this was answered.
  serverNow: number;
}

interface CrashRules {
  houseEdge: number;
  growthRate: number;
}

@Injectable()
export class CrashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly rng: RngService,
  ) {}

  // A round is "Crash-shaped" if its GameDefinition carries houseEdge +
  // growthRate — the same "detect by config shape" approach used for
  // Sum Dice's diceCount/diceSides, not a gameCode string check, so a
  // renamed or second Crash-style game still works without touching this.
  async crashRulesFor(gameCode: string): Promise<CrashRules | null> {
    const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode } });
    const rules = (game?.rulesJson as any) ?? {};
    if (typeof rules.houseEdge === 'number' && typeof rules.growthRate === 'number') {
      return { houseEdge: rules.houseEdge, growthRate: rules.growthRate };
    }
    return null;
  }

  // Called once, from RoundService.createRound, right after the round row
  // exists. Generates the hidden crash point — stored in GameRound.hiddenState,
  // which must NEVER be included in any client-facing round response before
  // settlement (see the schema comment and games.controller.ts's ROUND_SELECT) —
  // and returns the wall-clock instant the round will actually crash, so the
  // caller can schedule the one job that reveals it.
  async initializeCrashRound(roundId: string, rules: CrashRules, lockAt: Date): Promise<Date> {
    const randomInt = this.rng.randomInRange(0, 2 ** 31 - 1);
    const crashPoint = generateCrashPoint(randomInt, rules.houseEdge);

    await this.prisma.gameRound.update({
      where: { id: roundId },
      data: { hiddenState: { crashPoint } },
    });

    const seconds = crashTimeSeconds(crashPoint, rules.growthRate);
    return new Date(lockAt.getTime() + seconds * 1000);
  }

  // Live, poll-friendly status for the client's animation — never reveals
  // the crash point ahead of official settlement, even in the brief window
  // after the round has technically crashed but the settlement job hasn't
  // run yet (a real race, given job execution isn't instantaneous).
  async getStatus(roundId: string, now: number = Date.now()): Promise<CrashStatusView> {
    const round = await this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });

    if (round.status === 'SETTLED') {
      const result = round.result as any;
      return { status: 'CRASHED', multiplier: result?.crashPoint ?? null, serverNow: now };
    }
    if (round.status !== 'LOCKED') {
      return { status: round.status as 'SCHEDULED' | 'OPEN', multiplier: 1.0, serverNow: now };
    }

    const rules = await this.crashRulesFor(round.gameCode);
    const hidden = round.hiddenState as any;
    if (!rules || !hidden?.crashPoint) return { status: 'LIVE', multiplier: 1.0, serverNow: now };

    const elapsedSeconds = (now - round.lockAt.getTime()) / 1000;
    const crashAt = crashTimeSeconds(hidden.crashPoint, rules.growthRate);
    if (elapsedSeconds >= crashAt) {
      // The round has already crossed its server-authoritative crash time.
      // The hidden point is safe to reveal now because the outcome is over;
      // returning it here prevents the client from freezing at a lower
      // locally-estimated multiplier while the settlement worker catches up.
      return { status: 'CRASHED', multiplier: hidden.crashPoint, serverNow: now };
    }
    // `growthRate` and `elapsedMs` let the app draw the flight smoothly between
    // checks (the multiplier is exp(growthRate x seconds), a known curve). They give
    // away nothing about WHEN it will crash: that stays hidden until it has.
    return {
      status: 'LIVE',
      multiplier: currentMultiplier(elapsedSeconds, rules.growthRate),
      growthRate: rules.growthRate,
      elapsedMs: Math.max(0, Math.round(elapsedSeconds * 1000)),
      serverNow: now,
    };
  }

  // A manual cash-out request — the one action in this whole game that's a
  // live, human-timed decision rather than something resolvable at
  // settlement. elapsedSeconds is computed from the round's own recorded
  // lockAt against the current server clock; nothing here ever reads a
  // client-supplied multiplier or timestamp.
  async cashOut(roundId: string, userId: string) {
    const round = await this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    if (round.status !== 'LOCKED') {
      throw new BadRequestException('Round is not in its live phase');
    }

    const rules = await this.crashRulesFor(round.gameCode);
    const hidden = round.hiddenState as any;
    if (!rules || !hidden?.crashPoint) {
      throw new BadRequestException('This round has no crash configuration');
    }

    const entry = await this.prisma.gameEntry.findFirst({
      where: { roundId, userId, status: 'PLACED' },
    });
    if (!entry) throw new NotFoundException('No active entry to cash out for this round');

    const elapsedSeconds = (Date.now() - round.lockAt.getTime()) / 1000;
    const result = resolveCashout(elapsedSeconds, hidden.crashPoint, rules.growthRate);
    if (!result.success) {
      throw new BadRequestException('Too late — the round has already crashed');
    }

    const rewardAmount = computeCrashReward(entry.coinAmount, result.multiplier!);

    // Credit and the WON status update must commit together — same fix as
    // EntryService/GiftService/WithdrawalService/CoinPurchaseService.
    // credit() is itself idempotent on this key, so a duplicate cash-out
    // request racing with itself can't double-pay even without an extra
    // lock here — the same guarantee every other game's payout relies on;
    // this transaction closes the separate risk of the credit succeeding
    // but the entry never actually flipping to WON.
    return this.prisma.$transaction(async (tx) => {
      await creditGameReward(
        this.wallet,
        { userId, reward: rewardAmount, coinAmount: entry.coinAmount, bonusAmount: entry.bonusAmount, entryId: entry.id },
        tx,
      );

      return tx.gameEntry.update({
        where: { id: entry.id },
        data: {
          status: 'WON',
          cashedOutMultiplier: result.multiplier,
          cashedOutAt: new Date(),
          rewardAmount,
        },
      });
    }, EXTENDED_TX_OPTIONS);
  }

  // Called by the scheduled 'crash' job at the precomputed crash instant —
  // the only place GameRound.result gets written for a Crash round, same
  // terminal-state / no-silent-correction guarantee as SettlementService.settle()
  // for the other games.
  async settleCrash(roundId: string) {
    const round = await this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    if (round.status === 'SETTLED') return round; // idempotent
    if (round.status !== 'LOCKED') {
      throw new BadRequestException('Round must be LOCKED before crash-settling');
    }

    // Atomic claim — see SettlementService.settle(). The queue worker and the
    // round scheduler can both try to settle the same crashed round.
    const claimed = await this.prisma.gameRound.updateMany({ where: { id: roundId, status: 'LOCKED' }, data: { status: 'RESOLVING' } });
    if (claimed.count === 0) return this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });

    const hidden = round.hiddenState as any;
    const crashPoint = hidden.crashPoint;

    // Only entries still PLACED — anyone who already manually cashed out
    // is already WON and untouched here.
    const openEntries = await this.prisma.gameEntry.findMany({
      where: { roundId, status: 'PLACED' },
    });

    for (const entry of openEntries) {
      // Each entry's outcome (credit + status update, or just the status
      // update for a loss) commits atomically on its own — same fix as
      // cashOut() above, applied per-entry rather than as one transaction
      // spanning the whole round's entries, so one entry's failure can't
      // roll back everyone else's already-settled outcome in the same
      // round, and a round with many entries doesn't need one huge
      // transaction held open for all of them.
      if (entry.autoCashoutMultiplier != null) {
        const auto = resolveAutoCashout(entry.autoCashoutMultiplier, crashPoint);
        if (auto.won) {
          const rewardAmount = computeCrashReward(entry.coinAmount, auto.multiplier!);
          await this.prisma.$transaction(async (tx) => {
            await creditGameReward(
              this.wallet,
              { userId: entry.userId, reward: rewardAmount, coinAmount: entry.coinAmount, bonusAmount: entry.bonusAmount, entryId: entry.id },
              tx,
            );
            return tx.gameEntry.update({
              where: { id: entry.id },
              data: {
                status: 'WON',
                cashedOutMultiplier: auto.multiplier,
                cashedOutAt: new Date(),
                rewardAmount,
              },
            });
          }, EXTENDED_TX_OPTIONS);
          continue;
        }
      }
      // No auto-cashout set, or its target was never reached before the
      // crash — the stake was already debited at entry time, so a loss is
      // just marking the entry, not a further wallet movement (no
      // transaction needed here — it's a single write).
      await this.prisma.gameEntry.update({
        where: { id: entry.id },
        data: { status: 'LOST', rewardAmount: 0 },
      });
    }

    return this.prisma.gameRound.update({
      where: { id: roundId },
      data: { status: 'SETTLED', result: { crashPoint }, settledAt: new Date() },
    });
  }
}
