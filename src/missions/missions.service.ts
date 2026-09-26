import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, LedgerEntryType, MissionMetric, WalletType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RrydaLevelsService } from '../rryda-levels/rryda-levels.service';
import { BadgesService } from '../badges/badges.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { overlapSeconds } from '../creators/creator-analytics.service';

import { DEFAULT_DAY_OFFSET_MINUTES, dayPeriod, type DayPeriod } from '../common/day-period';
import { journeyTiers, resolvePerfectDayStreak, type JourneyTierKey } from './journey-tiers';

export type MissionPeriod = DayPeriod;

// The "day" a daily mission belongs to — see common/day-period.ts. Kept under
// its original name for existing callers and tests.
export const missionPeriod = dayPeriod;

// Rryda Journey chest rewards. Small deliberately: each Journey mission already pays its own
// small reward (see seed-missions.sql); these are the bonus for stringing several of them
// together in one day, same relationship the per-mission reward has to the underlying activity.
export const JOURNEY_HALFWAY_REWARD_COINS = 50;
export const JOURNEY_ALL_REWARD_COINS = 150;

// Derived, never stored — see the MissionDefinition schema comment.
@Injectable()
export class MissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
    private readonly rrydaLevels: RrydaLevelsService,
    private readonly badges: BadgesService,
  ) {}

  private offsetMinutes(): number {
    const raw = this.config.get<string>('MISSION_DAY_OFFSET_MINUTES');
    if (raw === undefined || raw === '') return DEFAULT_DAY_OFFSET_MINUTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_DAY_OFFSET_MINUTES;
  }

  // Shared by list() and claimTier(): today's active definitions this user can see, their
  // progress, and which of today's rewards (per-mission and per-tier) are already claimed.
  // A user with the CREATOR role sees creator missions in addition to the Journey (everyone)
  // ones; everyone else sees the Journey only.
  private async today(userId: string, isCreator: boolean, now: Date) {
    const period = missionPeriod(now, this.offsetMinutes());

    const [definitions, claims, tierClaims] = await Promise.all([
      this.prisma.missionDefinition.findMany({
        where: { active: true, ...(isCreator ? {} : { creatorOnly: false }) },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.missionClaim.findMany({ where: { userId, periodKey: period.key }, select: { missionId: true } }),
      this.prisma.missionTierClaim.findMany({ where: { userId, periodKey: period.key }, select: { tier: true } }),
    ]);
    const claimed = new Set(claims.map((c) => c.missionId));
    const claimedTiers = new Set(tierClaims.map((c) => c.tier));
    const progress = await this.progressFor(userId, new Set(definitions.map((d) => d.metric)), period, now);

    return { period, definitions, claimed, claimedTiers, progress };
  }

  async list(userId: string, isCreator: boolean) {
    const now = new Date();
    void this.badges.evaluateAndAward(userId);
    const { period, definitions, claimed, claimedTiers, progress } = await this.today(userId, isCreator, now);

    const [bonus, user] = await Promise.all([
      this.wallet.getBalance(userId, WalletType.BONUS),
      this.prisma.user.findUnique({ where: { id: userId }, select: { perfectDayStreak: true } }),
    ]);

    const journeyDefs = definitions.filter((d) => !d.creatorOnly);
    const journeyComplete = journeyDefs.filter((d) => (progress.get(d.metric) ?? 0) >= d.target).length;
    const tiers = journeyTiers(journeyDefs.length, JOURNEY_HALFWAY_REWARD_COINS, JOURNEY_ALL_REWARD_COINS).map((t) => ({
      ...t,
      reached: journeyComplete >= t.threshold,
      claimed: claimedTiers.has(t.key),
    }));

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
          creatorOnly: d.creatorOnly,
          progress: value,
          claimed: isClaimed,
          claimable: complete && !isClaimed,
        };
      }),
      // The Rryda Journey: today's everyone-audience progress and chest tiers, plus the streak
      // for stringing Perfect Days together. Always present (even for a creator, whose `missions`
      // array above also includes their creator-only ones) so the same screen works for anyone.
      journey: {
        completed: journeyComplete,
        total: journeyDefs.length,
        tiers,
        perfectDayStreak: user?.perfectDayStreak ?? 0,
      },
    };
  }

  // Pays the reward exactly once per (user, mission, day). The claim row and
  // the wallet credit commit together: the unique constraint on the claim is
  // the real once-only guarantee (a concurrent double-tap loses the race and
  // rolls back, crediting nothing), and the ledger key is derived from the
  // same triple so a retried credit can't double-pay either.
  async claim(userId: string, isCreator: boolean, missionId: string) {
    const mission = await this.prisma.missionDefinition.findUnique({ where: { id: missionId } });
    if (!mission || !mission.active) throw new NotFoundException('Mission not found');
    if (mission.creatorOnly && !isCreator) throw new NotFoundException('Mission not found');

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
    void this.rrydaLevels.addXp(userId, mission.rewardCoins); // Rryda Identity: every mission counts, not only creator ones
    return { claimed: true, rewardCoins: mission.rewardCoins, bonusBalance: bonus.toString() };
  }

  // Claims a Rryda Journey chest ("complete 3 -> Daily Chest", "complete 5 -> Perfect Day").
  // Available to every user — Journey missions are never creatorOnly, so `isCreator` doesn't
  // gate this the way it gates claim() above; a creator claims it from the same journey progress
  // as anyone else.
  async claimTier(userId: string, tier: JourneyTierKey) {
    const now = new Date();
    const { period, definitions, progress } = await this.today(userId, /* isCreator */ false, now);
    const journeyDefs = definitions.filter((d) => !d.creatorOnly);
    const journeyComplete = journeyDefs.filter((d) => (progress.get(d.metric) ?? 0) >= d.target).length;

    const tiers = journeyTiers(journeyDefs.length, JOURNEY_HALFWAY_REWARD_COINS, JOURNEY_ALL_REWARD_COINS);
    const target = tiers.find((t) => t.key === tier);
    if (!target) throw new NotFoundException('That Journey chest is not available today');
    if (journeyComplete < target.threshold) throw new BadRequestException('Journey chest is not ready yet');

    let streakResult: { alreadyToday: boolean; nextStreak: number } | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.missionTierClaim.create({
          data: { userId, periodKey: period.key, tier, rewardCoins: target.rewardCoins },
        });
        await this.wallet.credit(
          {
            userId,
            walletType: WalletType.BONUS,
            amount: BigInt(target.rewardCoins),
            ledgerType: LedgerEntryType.BONUS,
            reference: `journey_tier:${tier}:${period.key}`,
            idempotencyKey: `journey_tier_claim:${userId}:${tier}:${period.key}`,
          },
          tx,
        );
        // Perfect Day (the ALL tier) is also the Journey's own streak, alongside the existing
        // check-in streak — a different act (completing every Journey mission), tracked
        // separately rather than overloading checkInStreak.
        if (tier === 'ALL') {
          const user = await tx.user.findUnique({ where: { id: userId }, select: { perfectDayStreak: true, lastPerfectDayAt: true } });
          const resolved = resolvePerfectDayStreak(user?.lastPerfectDayAt ?? null, user?.perfectDayStreak ?? 0, now);
          streakResult = resolved;
          if (!resolved.alreadyToday) {
            await tx.user.update({ where: { id: userId }, data: { perfectDayStreak: resolved.nextStreak, lastPerfectDayAt: now } });
          }
        }
      }, EXTENDED_TX_OPTIONS);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('That Journey chest was already claimed today');
      }
      throw e;
    }

    const bonus = await this.wallet.getBalance(userId, WalletType.BONUS);
    void this.rrydaLevels.addXp(userId, target.rewardCoins);
    return {
      claimed: true,
      tier,
      rewardCoins: target.rewardCoins,
      bonusBalance: bonus.toString(),
      perfectDayStreak: streakResult?.nextStreak,
    };
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

    // --- Rryda Journey metrics: available to every user, counted from data that already exists
    // elsewhere (chat, gifts, game rounds, live viewing, follows) --- no new activity logging.

    if (metrics.has('MESSAGES_SENT')) {
      tasks.push(
        this.prisma.chatMessage
          .count({ where: { senderId: userId, createdAt: { gte: start, lt: end } } })
          .then((n) => void out.set('MESSAGES_SENT', n)),
      );
    }

    if (metrics.has('GIFTS_SENT')) {
      tasks.push(
        this.prisma.giftTransaction
          .count({ where: { senderId: userId, createdAt: { gte: start, lt: end } } })
          .then((n) => void out.set('GIFTS_SENT', n)),
      );
    }

    if (metrics.has('GAMES_PLAYED')) {
      // Counts an entry into any coin game (Ludo, Crash, Lucky Number, ...) — GameEntry is
      // written by all of them, so this needed no per-game wiring.
      tasks.push(
        this.prisma.gameEntry
          .count({ where: { userId, createdAt: { gte: start, lt: end } } })
          .then((n) => void out.set('GAMES_PLAYED', n)),
      );
    }

    if (metrics.has('LIVE_SESSIONS_WATCHED')) {
      tasks.push(
        this.prisma.liveViewer
          .findMany({ where: { userId, joinedAt: { gte: start, lt: end } }, distinct: ['sessionId'], select: { sessionId: true } })
          .then((rows) => void out.set('LIVE_SESSIONS_WATCHED', rows.length)),
      );
    }

    if (metrics.has('NEW_FOLLOWS_MADE')) {
      // The Journey's "meet someone new": following someone, not being followed
      // (that direction is NEW_FOLLOWERS above, a creator-only metric).
      tasks.push(
        this.prisma.follow
          .count({ where: { followerId: userId, createdAt: { gte: start, lt: end } } })
          .then((n) => void out.set('NEW_FOLLOWS_MADE', n)),
      );
    }

    await Promise.all(tasks);
    return out;
  }
}
