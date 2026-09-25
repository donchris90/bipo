// Idempotent settlement for Lucky Number, following the exact claim pattern
// SettlementService.settle() already uses for sum-dice/lucky (LOCKED ->
// RESOLVING via a conditional updateMany, then per-entry PLACED -> WON/LOST).
// Kept as a standalone function (rather than folded into settlement.service.ts)
// so the pure math above stays trivially unit-testable, and so wiring this
// into the real Prisma models is a small, reviewable diff instead of a
// rewrite of the existing service.
//
// This file documents the integration shape; it assumes the same
// GameRound / GameEntry models settlement.service.ts already uses, with
// `entry.selection` storing { [number: string]: stake } for a Lucky Number
// entry (as opposed to sum-dice's number[] selection).

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../../economy/wallet.service';
import { RngService } from '../rng.service';
import { EXTENDED_TX_OPTIONS } from '../../prisma/prisma-transaction-options';
import { creditGameReward } from '../game-payout';
import { computeMultipliers, settleLuckyNumber, LuckyNumberConfig } from './lucky-number-math';

export type LuckyNumberSelection = Record<string, number>; // { "7": 39, "13": 84, ... }

function selectionToStakeMap(selection: LuckyNumberSelection): Map<number, number> {
  return new Map(Object.entries(selection).map(([n, s]) => [Number(n), Number(s)]));
}

@Injectable()
export class LuckyNumberSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly rng: RngService,
  ) {}

  async settle(roundId: string, config: LuckyNumberConfig) {
    const round = await this.prisma.gameRound.findUnique({ where: { id: roundId } });
    if (!round) throw new NotFoundException('Round not found');
    if (round.status === 'SETTLED') return round; // a round is settled only once — see claim below too

    if (round.status !== 'LOCKED') throw new BadRequestException('Round must be LOCKED before settling');

    // Atomic claim: only the caller that flips LOCKED -> RESOLVING may draw
    // the result and pay entries. Anyone racing this (a retried job, a
    // second instance) gets count === 0 and just returns the current row —
    // this is what makes "a round is settled only once" true under
    // concurrency, not just in the common case.
    const claimed = await this.prisma.gameRound.updateMany({
      where: { id: roundId, status: 'LOCKED' },
      data: { status: 'RESOLVING' },
    });
    if (claimed.count === 0) {
      return this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    }

    // Three independent CSPRNG digits 0-9; only their sum is the result.
    const digits: [number, number, number] = [
      this.rng.randomInRange(0, 9),
      this.rng.randomInRange(0, 9),
      this.rng.randomInRange(0, 9),
    ];
    const resultSum = digits[0] + digits[1] + digits[2];
    const multipliers = computeMultipliers(config.rtp, config.multiplierCap);

    // Only PLACED entries — anything already refunded/settled is never paid
    // again, same guard settlement.service.ts uses.
    const entries = await this.prisma.gameEntry.findMany({ where: { roundId, status: 'PLACED' } });

    for (const entry of entries) {
      const stakes = selectionToStakeMap(entry.selection as LuckyNumberSelection);
      const { won, payout } = settleLuckyNumber(stakes, resultSum, multipliers);

      if (won && payout > 0) {
        // Credit + status update commit together so a crash between them
        // can never leave a paid entry stuck at PLACED (same fix already
        // applied to CrashService and the sum-dice path above).
        await this.prisma.$transaction(async (tx) => {
          await creditGameReward(
            this.wallet,
            { userId: entry.userId, reward: payout, coinAmount: entry.coinAmount, bonusAmount: entry.bonusAmount, entryId: entry.id },
            tx,
          );
          return tx.gameEntry.update({ where: { id: entry.id }, data: { status: 'WON', rewardAmount: payout } });
        }, EXTENDED_TX_OPTIONS);
      } else {
        await this.prisma.gameEntry.update({ where: { id: entry.id }, data: { status: 'LOST', rewardAmount: 0 } });
      }
    }

    return this.prisma.gameRound.update({
      where: { id: roundId },
      data: { status: 'SETTLED', result: { digits, sum: resultSum } as any, settledAt: new Date() },
    });
  }
}
