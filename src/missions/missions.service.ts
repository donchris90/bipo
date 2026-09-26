import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, LedgerEntryType, MissionMetric, RoleName, WalletType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RrydaLevelsService } from '../rryda-levels/rryda-levels.service';
import { BadgesService } from '../badges/badges.service';
import { AuditService } from '../audit/audit.service';
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
// These are only the FALLBACK used if no admin-set JourneyConfig row exists (e.g. a fresh
// install before an admin has touched the Journey page) — see journeyRewardConfig() below.
export const JOURNEY_HALFWAY_REWARD_COINS = 50;
export const JOURNEY_ALL_REWARD_COINS = 150;

const JOURNEY_CONFIG_ID = 'default';
const MAX_REWARD_COINS = 1_000_000;

// Derived, never stored — see the MissionDefinition schema comment.
@Injectable()
export class MissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
    private readonly rrydaLevels: RrydaLevelsService,
    private readonly badges: BadgesService,
    private readonly audit: AuditService,
  ) {}

  // The admin-editable halfway/all chest rewards, falling back to the constants above if no
  // JourneyConfig row exists yet.
  private async journeyRewardConfig(): Promise<{ halfwayRewardCoins: number; allRewardCoins: number }> {
    const row = await this.prisma.journeyConfig.findUnique({ where: { id: JOURNEY_CONFIG_ID } });
    return {
      halfwayRewardCoins: row?.halfwayRewardCoins ?? JOURNEY_HALFWAY_REWARD_COINS,
      allRewardCoins: row?.allRewardCoins ?? JOURNEY_ALL_REWARD_COINS,
    };
  }

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

    const [bonus, user, rewardConfig] = await Promise.all([
      this.wallet.getBalance(userId, WalletType.BONUS),
      this.prisma.user.findUnique({ where: { id: userId }, select: { perfectDayStreak: true } }),
      this.journeyRewardConfig(),
    ]);

    const journeyDefs = definitions.filter((d) => !d.creatorOnly);
    const journeyComplete = journeyDefs.filter((d) => (progress.get(d.metric) ?? 0) >= d.target).length;
    const tiers = journeyTiers(journeyDefs.length, rewardConfig.halfwayRewardCoins, rewardConfig.allRewardCoins).map((t) => ({
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
    const [{ period, definitions, progress }, rewardConfig] = await Promise.all([
      this.today(userId, /* isCreator */ false, now),
      this.journeyRewardConfig(),
    ]);
    const journeyDefs = definitions.filter((d) => !d.creatorOnly);
    const journeyComplete = journeyDefs.filter((d) => (progress.get(d.metric) ?? 0) >= d.target).length;

    const tiers = journeyTiers(journeyDefs.length, rewardConfig.halfwayRewardCoins, rewardConfig.allRewardCoins);
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

  // ── Admin: mission definitions ──────────────────────────────────────────────────────────
  // Everything below backs the admin Missions/Journey page — the mobile app and claim() /
  // list() above never call these.

  async adminList() {
    return this.prisma.missionDefinition.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  }

  // Fixed set: each metric is computed by a specific branch of progressFor() above, so an admin
  // can only pick from metrics the server actually knows how to measure, not type in an arbitrary
  // string.
  adminMetrics(): { value: MissionMetric; creatorOnly: boolean }[] {
    return [
      { value: 'LIVE_MINUTES', creatorOnly: true },
      { value: 'PK_WINS', creatorOnly: true },
      { value: 'GIFT_COINS_RECEIVED', creatorOnly: true },
      { value: 'NEW_FOLLOWERS', creatorOnly: true },
      { value: 'MESSAGES_SENT', creatorOnly: false },
      { value: 'GIFTS_SENT', creatorOnly: false },
      { value: 'GAMES_PLAYED', creatorOnly: false },
      { value: 'LIVE_SESSIONS_WATCHED', creatorOnly: false },
      { value: 'NEW_FOLLOWS_MADE', creatorOnly: false },
    ];
  }

  private validateMissionInput(body: any, { requireCode }: { requireCode: boolean }) {
    const title = String(body.title ?? '').trim();
    const description = String(body.description ?? '').trim();
    const target = Math.floor(Number(body.target));
    const rewardCoins = Math.floor(Number(body.rewardCoins));
    const metric = body.metric as MissionMetric;
    const validMetrics = new Set(this.adminMetrics().map((m) => m.value));

    if (requireCode) {
      const code = String(body.code ?? '').trim();
      if (!/^[a-z][a-z0-9_]{2,59}$/.test(code)) {
        throw new BadRequestException('code must be lowercase letters, numbers and underscores, 3-60 characters, starting with a letter');
      }
    }
    if (!title || title.length > 120) throw new BadRequestException('title is required and must be 120 characters or less');
    if (!description || description.length > 500) throw new BadRequestException('description is required and must be 500 characters or less');
    if (!validMetrics.has(metric)) throw new BadRequestException(`metric must be one of: ${Array.from(validMetrics).join(', ')}`);
    if (!Number.isFinite(target) || target < 1 || target > 10_000_000) throw new BadRequestException('target must be between 1 and 10,000,000');
    if (!Number.isFinite(rewardCoins) || rewardCoins < 0 || rewardCoins > MAX_REWARD_COINS) {
      throw new BadRequestException(`rewardCoins must be between 0 and ${MAX_REWARD_COINS}`);
    }
    return { title, description, target, rewardCoins, metric };
  }

  async adminCreate(body: any, actorId: string, roles: RoleName[]) {
    const code = String(body.code ?? '').trim();
    const { title, description, target, rewardCoins, metric } = this.validateMissionInput(body, { requireCode: true });

    const existing = await this.prisma.missionDefinition.findUnique({ where: { code } });
    if (existing) throw new ConflictException('A mission with that code already exists');

    const last = await this.prisma.missionDefinition.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const sortOrder = Number.isFinite(Number(body.sortOrder)) && body.sortOrder !== undefined && body.sortOrder !== ''
      ? Math.floor(Number(body.sortOrder))
      : (last?.sortOrder ?? 0) + 1;

    const created = await this.prisma.missionDefinition.create({
      data: {
        code,
        title,
        description,
        metric,
        target,
        rewardCoins,
        creatorOnly: body.creatorOnly === true,
        active: body.active !== false,
        sortOrder,
      },
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'mission_definition.create', targetType: 'mission_definition', targetId: created.id, metadata: { code, title, metric, target, rewardCoins } });
    return created;
  }

  async adminUpdate(id: string, body: any, actorId: string, roles: RoleName[]) {
    const existing = await this.prisma.missionDefinition.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Mission not found');
    // code is the stable identifier claims/rewards reference (see MissionClaim.reference in
    // claim() above) — like HostLevel's level number, it's set once at creation and never edited.
    const { title, description, target, rewardCoins, metric } = this.validateMissionInput(body, { requireCode: false });
    const sortOrder = body.sortOrder === undefined || body.sortOrder === '' ? existing.sortOrder : Math.floor(Number(body.sortOrder));
    if (!Number.isFinite(sortOrder)) throw new BadRequestException('sortOrder must be a number');

    const updated = await this.prisma.missionDefinition.update({
      where: { id },
      data: {
        title,
        description,
        metric,
        target,
        rewardCoins,
        creatorOnly: body.creatorOnly === true,
        active: body.active !== false,
        sortOrder,
      },
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'mission_definition.update', targetType: 'mission_definition', targetId: id, metadata: { title, metric, target, rewardCoins, active: updated.active } });
    return updated;
  }

  // Swaps this mission's sortOrder with the one immediately before/after it in the current
  // ordering — the "move up / move down" arrows in the admin table. A full drag-and-drop
  // reorder isn't needed for a handful of daily missions.
  async adminMove(id: string, direction: 'up' | 'down', actorId: string, roles: RoleName[]) {
    const all = await this.prisma.missionDefinition.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const index = all.findIndex((m) => m.id === id);
    if (index === -1) throw new NotFoundException('Mission not found');
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= all.length) return all;

    const a = all[index];
    const b = all[swapWith];
    await this.prisma.$transaction([
      this.prisma.missionDefinition.update({ where: { id: a.id }, data: { sortOrder: b.sortOrder } }),
      this.prisma.missionDefinition.update({ where: { id: b.id }, data: { sortOrder: a.sortOrder } }),
    ]);
    await this.audit.record({ actorId, actorRole: roles[0], action: 'mission_definition.reorder', targetType: 'mission_definition', targetId: a.id, metadata: { direction, swappedWith: b.id } });
    return this.adminList();
  }

  // Only removes a mission that was never claimed — one with history is deactivated instead
  // (active: false), never deleted, so past MissionClaim rows keep a definition to join against.
  async adminDelete(id: string, actorId: string, roles: RoleName[]) {
    const existing = await this.prisma.missionDefinition.findUnique({ where: { id }, include: { _count: { select: { claims: true } } } });
    if (!existing) throw new NotFoundException('Mission not found');
    if (existing._count.claims > 0) {
      throw new BadRequestException('This mission has already been claimed by users — deactivate it instead of deleting it');
    }
    await this.prisma.missionDefinition.delete({ where: { id } });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'mission_definition.delete', targetType: 'mission_definition', targetId: id, metadata: { code: existing.code } });
    return { deleted: true };
  }

  // ── Admin: Rryda Journey chest rewards ──────────────────────────────────────────────────
  async adminGetJourneyConfig() {
    const config = await this.journeyRewardConfig();
    return { id: JOURNEY_CONFIG_ID, ...config };
  }

  async adminUpdateJourneyConfig(body: any, actorId: string, roles: RoleName[]) {
    const halfwayRewardCoins = Math.floor(Number(body.halfwayRewardCoins));
    const allRewardCoins = Math.floor(Number(body.allRewardCoins));
    if (!Number.isFinite(halfwayRewardCoins) || halfwayRewardCoins < 0 || halfwayRewardCoins > MAX_REWARD_COINS) {
      throw new BadRequestException(`halfwayRewardCoins must be between 0 and ${MAX_REWARD_COINS}`);
    }
    if (!Number.isFinite(allRewardCoins) || allRewardCoins < 0 || allRewardCoins > MAX_REWARD_COINS) {
      throw new BadRequestException(`allRewardCoins must be between 0 and ${MAX_REWARD_COINS}`);
    }
    // Perfect Day (ALL) is meant to pay out more than the halfway chest — same "bigger chest for
    // more effort" relationship the Journey teaches with its per-mission rewards.
    if (allRewardCoins < halfwayRewardCoins) {
      throw new BadRequestException('allRewardCoins should be at least halfwayRewardCoins');
    }
    const updated = await this.prisma.journeyConfig.upsert({
      where: { id: JOURNEY_CONFIG_ID },
      update: { halfwayRewardCoins, allRewardCoins },
      create: { id: JOURNEY_CONFIG_ID, halfwayRewardCoins, allRewardCoins },
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'journey_config.update', targetType: 'journey_config', targetId: JOURNEY_CONFIG_ID, metadata: { halfwayRewardCoins, allRewardCoins } });
    return updated;
  }
}
