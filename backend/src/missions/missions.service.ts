import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, LedgerEntryType, MissionMetric, WalletType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { overlapSeconds } from '../creators/creator-analytics.service';

import { DEFAULT_DAY_OFFSET_MINUTES, dayPeriod, type DayPeriod } from '../common/day-period';

export type MissionPeriod = DayPeriod;

// The "day" a daily mission belongs to — see common/day-period.ts. Kept under
// its original name for existing callers and tests.
export const missionPeriod = dayPeriod;

// Derived, never stored — see the MissionDefinition schema comment.
@Injectable()
export class MissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
  ) {}

  private offsetMinutes(): number {
    const raw = this.config.get<string>('MISSION_DAY_OFFSET_MINUTES');
    if (raw === undefined || raw === '') return DEFAULT_DAY_OFFSET_MINUTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_DAY_OFFSET_MINUTES;
  }

  async list(userId: string) {
    const now = new Date();
    const period = missionPeriod(now, this.offsetMinutes());

    const [definitions, claims] = await Promise.all([
      this.prisma.missionDefinition.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.missionClaim.findMany({ where: { userId, periodKey: period.key }, select: { missionId: true } }),
    ]);
    const claimed = new Set(claims.map((c) => c.missionId));
    const progress = await this.progressFor(
      userId,
      new Set(definitions.map((d) => d.metric)),
      period,
      now,
    );

    const bonus = await this.wallet.getBalance(userId, WalletType.BONUS);

    return {
      period: { key: period.key, start: period.start, resetsAt: period.end },
      bonusBalance: bonus.toString(),
      missions: definitions.map((d) => {
        const value = progress.get(d.metric) ?? 0;
        const complete = value >= d.target;
        const isClaimed = claimed.has(d.id);
        return {
          id: d.id,
          code: d.code,
          title: d.title,
          description: d.description,
          metric: d.metric,
          target: d.target,
          rewardCoins: d.rewardCoins,
          progress: value,
          claimed: isClaimed,
          claimable: complete && !isClaimed,
        };
      }),
    };
  }

  // Pays the reward exactly once per (user, mission, day). The claim row and
  // the wallet credit commit together: the unique constraint on the claim is
  // the real once-only guarantee (a concurrent double-tap loses the race and
  // rolls back, crediting nothing), and the ledger key is derived from the
  // same triple so a retried credit can't double-pay either.
  async claim(userId: string, missionId: string) {
    const mission = await this.prisma.missionDefinition.findUnique({ where: { id: missionId } });
    if (!mission || !mission.active) throw new NotFoundException('Mission not found');

    const now = new Date();
    const period = missionPeriod(now, this.offsetMinutes());

    const progress = await this.progressFor(userId, new Set([mission.metric]), period, now);
    if ((progress.get(mission.metric) ?? 0) < mission.target) {
      throw new BadRequestException('Mission is not complete yet');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.missionClaim.create({
          data: { userId, missionId, periodKey: period.key, rewardCoins: mission.rewardCoins },
        });
        await this.wallet.credit(
          {
            userId,
            walletType: WalletType.BONUS,
            amount: BigInt(mission.rewardCoins),
            ledgerType: LedgerEntryType.BONUS,
            reference: `mission:${mission.code}:${period.key}`,
            idempotencyKey: `mission_claim:${userId}:${missionId}:${period.key}`,
          },
          tx,
        );
      }, EXTENDED_TX_OPTIONS);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Reward already claimed today');
      }
      throw e;
    }

    const bonus = await this.wallet.getBalance(userId, WalletType.BONUS);
    return { claimed: true, rewardCoins: mission.rewardCoins, bonusBalance: bonus.toString() };
  }

  // Each requested metric is computed once, however many missions use it.
  private async progressFor(
    userId: string,
    metrics: Set<MissionMetric>,
    period: MissionPeriod,
    now: Date,
  ): Promise<Map<MissionMetric, number>> {
    const { start, end } = period;
    const out = new Map<MissionMetric, number>();
    const tasks: Promise<void>[] = [];

    if (metrics.has('LIVE_MINUTES')) {
      tasks.push(
        this.prisma.liveSession
          .findMany({
            where: {
              hostId: userId,
              startedAt: { not: null, lt: end },
              OR: [{ status: 'LIVE' }, { endedAt: { gte: start } }],
            },
            select: { startedAt: true, endedAt: true },
            take: 200,
          })
          .then((sessions) => {
            let seconds = 0;
            for (const s of sessions) {
              if (s.startedAt) seconds += overlapSeconds(s.startedAt, s.endedAt ?? now, start, end);
            }
            out.set('LIVE_MINUTES', Math.floor(seconds / 60));
          }),
      );
    }

    if (metrics.has('PK_WINS')) {
      tasks.push(
        this.prisma.pKBattle
          .count({ where: { status: 'SETTLED', winnerId: userId, settledAt: { gte: start, lt: end } } })
          .then((n) => void out.set('PK_WINS', n)),
      );
    }

    if (metrics.has('GIFT_COINS_RECEIVED')) {
      tasks.push(
        this.prisma.giftTransaction
          .aggregate({
            where: { recipientId: userId, createdAt: { gte: start, lt: end } },
            _sum: { coinAmount: true },
          })
          .then((agg) => void out.set('GIFT_COINS_RECEIVED', agg._sum.coinAmount ?? 0)),
      );
    }

    if (metrics.has('NEW_FOLLOWERS')) {
      tasks.push(
        this.prisma.follow
          .count({ where: { followingId: userId, createdAt: { gte: start, lt: end } } })
          .then((n) => void out.set('NEW_FOLLOWERS', n)),
      );
    }

    await Promise.all(tasks);
    return out;
  }
}
