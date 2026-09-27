import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { LedgerEntryType, RoleName, WalletType } from '@prisma/client';

export type SeasonStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'SETTLED';

// Rryda Seasons: a time-boxed competitive period ("Rryda Season 1", or a short one like "Friday
// Night PK"). Structural core only — event-specific missions and a dedicated event-badge catalog
// are NOT part of this service; they'd sit on top of this foundation, same reasoning as
// TeamsService/RoomCommunityService before it.
//
// No "join" step: everyone using the app during the window competes automatically. There is also
// no stored status field — SCHEDULED/ACTIVE/ENDED/SETTLED is always derived from `now` against
// startsAt/endsAt/settledAt, so nothing needs a background job just to flip a flag.
@Injectable()
export class SeasonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  static readonly MAX_NAME_LENGTH = 60;

  deriveStatus(season: { startsAt: Date; endsAt: Date; settledAt: Date | null }, now: Date): SeasonStatus {
    if (season.settledAt) return 'SETTLED';
    if (now < season.startsAt) return 'SCHEDULED';
    if (now <= season.endsAt) return 'ACTIVE';
    return 'ENDED';
  }

  // ---- Contribution: every point-earning action feeds every CURRENTLY ACTIVE season ---------

  // Called from the same everyday-activity call sites as RrydaLevelsService.addXp and
  // TeamsService.contributeXp: missions, chests, check-in, following someone new. NOT wired into
  // gift-sending in this pass — gift.service.ts lives inside EconomyModule, which this service
  // already depends on for WalletService (settlement payouts); having EconomyModule import
  // SeasonsModule back would create a real circular module dependency
  // (EconomyModule -> SeasonsModule -> EconomyModule). Adding it later needs either WalletService
  // moved into its own smaller module, or a deliberate forwardRef() on one side — not done here
  // since it can't be verified without booting the real app. Usually at most one season is active
  // at a time, but nothing here assumes that — a regional event could run alongside a global
  // season, and both would credit the same action. Never throws: a season is a bonus signal,
  // never a reason to fail the action that earned it.
  async contributePoints(userId: string, amount: number) {
    const safe = Math.floor(Number(amount));
    if (!Number.isFinite(safe) || safe <= 0) return;
    try {
      const now = new Date();
      const active = await this.prisma.season.findMany({ where: { startsAt: { lte: now }, endsAt: { gte: now } } });
      for (const season of active) {
        await this.prisma.seasonParticipant.upsert({
          where: { seasonId_userId: { seasonId: season.id, userId } },
          update: { points: { increment: safe } },
          create: { seasonId: season.id, userId, points: safe },
        });
      }
    } catch {
      /* a season is a bonus signal, never a reason to fail the action that earned it */
    }
  }

  // ---- Reads ----------------------------------------------------------------------------------

  private async rankOf(seasonId: string, points: number): Promise<number> {
    return 1 + (await this.prisma.seasonParticipant.count({ where: { seasonId, points: { gt: points } } }));
  }

  // The currently-running season (if any), or — failing that — the next scheduled one, so the
  // app always has something to show ("Season 2 starts in 3 days") rather than nothing between
  // seasons. Null only when there is truly no season configured at all.
  async currentOrNext(): Promise<{ id: string; name: string; description: string | null; startsAt: Date; endsAt: Date; status: SeasonStatus } | null> {
    const now = new Date();
    const active = await this.prisma.season.findFirst({ where: { startsAt: { lte: now }, endsAt: { gte: now } }, orderBy: { startsAt: 'asc' } });
    const season = active ?? (await this.prisma.season.findFirst({ where: { startsAt: { gt: now } }, orderBy: { startsAt: 'asc' } }));
    if (!season) return null;
    return { id: season.id, name: season.name, description: season.description, startsAt: season.startsAt, endsAt: season.endsAt, status: this.deriveStatus(season, now) };
  }

  async seasonSnapshot(seasonId: string, viewerId: string) {
    const season = await this.prisma.season.findUnique({ where: { id: seasonId } });
    if (!season) return null;
    const now = new Date();
    const [participantCount, viewerRow, tiers] = await Promise.all([
      this.prisma.seasonParticipant.count({ where: { seasonId } }),
      this.prisma.seasonParticipant.findUnique({ where: { seasonId_userId: { seasonId, userId: viewerId } } }),
      this.prisma.seasonRewardTier.findMany({ where: { seasonId }, orderBy: { minRank: 'asc' } }),
    ]);
    const viewerRank = viewerRow ? await this.rankOf(seasonId, viewerRow.points) : null;
    return {
      id: season.id,
      name: season.name,
      description: season.description,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      status: this.deriveStatus(season, now),
      participantCount,
      rewardTiers: tiers.map((t) => ({ minRank: t.minRank, maxRank: t.maxRank, rewardCoins: t.rewardCoins })),
      viewer: viewerRow ? { points: viewerRow.points, rank: viewerRank } : { points: 0, rank: null },
    };
  }

  async listLeaderboard(seasonId: string, limit = 20) {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
    const rows = await this.prisma.seasonParticipant.findMany({ where: { seasonId }, orderBy: { points: 'desc' }, take: safeLimit });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, displayName: true, avatarUrl: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r, index) => ({
      rank: index + 1,
      userId: r.userId,
      displayName: byId.get(r.userId)?.displayName ?? null,
      avatarUrl: byId.get(r.userId)?.avatarUrl ?? null,
      points: r.points,
    }));
  }

  // ---- Admin: create seasons, configure reward tiers, settle ---------------------------------

  private validateName(name: unknown): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new BadRequestException('Season name is required');
    if (trimmed.length > SeasonsService.MAX_NAME_LENGTH) throw new BadRequestException(`Season name must be ${SeasonsService.MAX_NAME_LENGTH} characters or fewer`);
    return trimmed;
  }

  async listSeasons() {
    const now = new Date();
    const rows = await this.prisma.season.findMany({ orderBy: { startsAt: 'desc' } });
    return rows.map((s) => ({ id: s.id, name: s.name, description: s.description, startsAt: s.startsAt, endsAt: s.endsAt, status: this.deriveStatus(s, now) }));
  }

  async createSeason(actorId: string, roles: RoleName[], input: { name: string; description?: string; startsAt: string | Date; endsAt: string | Date }) {
    const name = this.validateName(input.name);
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new BadRequestException('startsAt and endsAt must be valid dates');
    if (endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');

    const overlapping = await this.prisma.season.findFirst({ where: { startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } });
    if (overlapping) throw new ConflictException(`Overlaps with an existing season: "${overlapping.name}"`);

    const season = await this.prisma.season.create({ data: { name, description: input.description?.trim() || null, startsAt, endsAt } });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'season.create', targetType: 'season', targetId: season.id, metadata: { name, startsAt, endsAt } });
    return season;
  }

  // Replaces the whole tier list atomically — simplest correct semantics for "here is the reward
  // table now", the same replace-the-list shape most admin config editors in this codebase use.
  async setRewardTiers(seasonId: string, actorId: string, roles: RoleName[], tiers: Array<{ minRank: number; maxRank: number; rewardCoins: number }>) {
    const season = await this.prisma.season.findUnique({ where: { id: seasonId } });
    if (!season) throw new NotFoundException('Season not found');
    if (season.settledAt) throw new BadRequestException('This season has already been settled — reward tiers can no longer be changed');

    for (const t of tiers) {
      if (!Number.isInteger(t.minRank) || !Number.isInteger(t.maxRank) || t.minRank < 1 || t.maxRank < t.minRank) {
        throw new BadRequestException('Each tier needs a valid minRank <= maxRank, both >= 1');
      }
      if (!Number.isFinite(t.rewardCoins) || t.rewardCoins < 0) throw new BadRequestException('rewardCoins must be a non-negative number');
    }
    const sorted = [...tiers].sort((a, b) => a.minRank - b.minRank);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].minRank <= sorted[i - 1].maxRank) throw new BadRequestException('Reward tiers must not overlap');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.seasonRewardTier.deleteMany({ where: { seasonId } });
      for (const t of tiers) await tx.seasonRewardTier.create({ data: { seasonId, minRank: t.minRank, maxRank: t.maxRank, rewardCoins: t.rewardCoins } });
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'season.set_reward_tiers', targetType: 'season', targetId: seasonId, metadata: { tiers } });
    return this.prisma.seasonRewardTier.findMany({ where: { seasonId }, orderBy: { minRank: 'asc' } });
  }

  // Pays out every participant who lands in a configured reward tier, once, then marks the season
  // settled so it can never be paid out twice. Refuses to run before the season has actually ended
  // — settling early would let someone's later points not count, defeating the point of a season.
  async settleSeason(seasonId: string, actorId: string, roles: RoleName[]) {
    const season = await this.prisma.season.findUnique({ where: { id: seasonId } });
    if (!season) throw new NotFoundException('Season not found');
    if (season.settledAt) throw new ConflictException('This season has already been settled');
    const now = new Date();
    if (now <= season.endsAt) throw new ForbiddenException('This season has not ended yet');

    const [tiers, ranked] = await Promise.all([
      this.prisma.seasonRewardTier.findMany({ where: { seasonId }, orderBy: { minRank: 'asc' } }),
      this.prisma.seasonParticipant.findMany({ where: { seasonId }, orderBy: { points: 'desc' } }),
    ]);

    const payouts: Array<{ userId: string; rank: number; rewardCoins: number }> = [];
    ranked.forEach((row, index) => {
      const rank = index + 1;
      const tier = tiers.find((t) => rank >= t.minRank && rank <= t.maxRank);
      if (tier && tier.rewardCoins > 0) payouts.push({ userId: row.userId, rank, rewardCoins: tier.rewardCoins });
    });

    await this.prisma.$transaction(async (tx) => {
      for (const p of payouts) {
        await this.wallet.credit(
          {
            userId: p.userId,
            walletType: WalletType.BONUS,
            amount: BigInt(p.rewardCoins),
            ledgerType: LedgerEntryType.BONUS,
            reference: `season_reward:${seasonId}:${p.userId}`,
            idempotencyKey: `season_reward:${seasonId}:${p.userId}`,
          },
          tx,
        );
      }
      await tx.season.update({ where: { id: seasonId }, data: { settledAt: now } });
    });

    for (const p of payouts) {
      await this.notifications.notifyOnce(p.userId, 'SEASON_REWARD', `season-reward:${seasonId}`, {
        seasonId, seasonName: season.name, rank: p.rank, rewardCoins: p.rewardCoins,
      });
    }

    await this.audit.record({ actorId, actorRole: roles[0], action: 'season.settle', targetType: 'season', targetId: seasonId, metadata: { paidOut: payouts.length } });
    return { settled: true, paidOut: payouts.length, totalParticipants: ranked.length };
  }
}
