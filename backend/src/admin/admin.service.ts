import { namesMatch } from '../kyc/kyc-rules';
import { Injectable } from '@nestjs/common';
import {
  AgencyStatus,
  CreatorApplicationStatus,
  LiveStatus,
  PurchaseStatus,
  RoleName,
  UserStatus,
  WithdrawalStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { clampLimit, parseBefore, parseEnumFilter, userSearchWhere } from './admin-query';

const DAY_MS = 24 * 60 * 60 * 1000;

export const FINANCE_ROLES: RoleName[] = [RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN];

interface Page {
  limit?: unknown;
  before?: unknown;
}

// READ side of the admin dashboard. Every write the dashboard performs uses the
// existing, already role-guarded endpoints (suspend/ban a user, approve a
// withdrawal, ...); this service only supplies what those screens need to
// *show*: the lists and counts that had no endpoint. Nothing here mutates.
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // display names for a set of user ids, in one query
  private async namesFor(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map<string, { displayName: string | null; email: string }>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true, email: true },
    });
    return new Map(users.map((u) => [u.id, { displayName: u.displayName, email: u.email }]));
  }

  async overview(roles: RoleName[]) {
    const now = Date.now();
    const canFinance = roles.some((r) => FINANCE_ROLES.includes(r));

    const [
      totalUsers,
      newUsers24h,
      liveNow,
      openRooms,
      pendingApplications,
      pendingWithdrawals,
      pendingAgencies,
      pendingKyc,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: new Date(now - DAY_MS) } } }),
      this.prisma.liveSession.count({ where: { status: LiveStatus.LIVE } }),
      this.prisma.partyRoom.count({ where: { status: 'OPEN' } }),
      this.prisma.creatorApplication.count({ where: { status: CreatorApplicationStatus.PENDING } }),
      this.prisma.withdrawalRequest.count({ where: { status: WithdrawalStatus.PENDING_REVIEW } }),
      this.prisma.agency.count({ where: { status: AgencyStatus.PENDING } }),
      this.prisma.kycSubmission.count({ where: { status: 'PENDING' } }),
    ]);

    // Money figures are only computed for, and only sent to, finance roles.
    let finance: null | {
      purchases30d: { currencyCode: string; amountMinor: number; count: number }[];
      pendingWithdrawalCoins: number;
    } = null;
    if (canFinance) {
      const [purchases, pending] = await Promise.all([
        this.prisma.coinPurchase.groupBy({
          by: ['currencyCode'],
          where: { status: PurchaseStatus.CONFIRMED, confirmedAt: { gte: new Date(now - 30 * DAY_MS) } },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
        this.prisma.withdrawalRequest.aggregate({
          where: { status: WithdrawalStatus.PENDING_REVIEW },
          _sum: { amountMinor: true },
        }),
      ]);
      finance = {
        purchases30d: purchases.map((p) => ({
          currencyCode: p.currencyCode,
          amountMinor: p._sum.amountMinor ?? 0,
          count: p._count._all,
        })),
        pendingWithdrawalCoins: pending._sum.amountMinor ?? 0,
      };
    }

    return {
      users: { total: totalUsers, joinedLast24h: newUsers24h },
      live: { sessionsNow: liveNow, openPartyRooms: openRooms },
      queues: { creatorApplications: pendingApplications, withdrawals: pendingWithdrawals, agencies: pendingAgencies, kyc: pendingKyc },
      finance,
    };
  }

  async users(q: Page & { search?: unknown; status?: unknown }) {
    const take = clampLimit(q.limit);
    const before = parseBefore(q.before);
    const status = parseEnumFilter(q.status, Object.values(UserStatus));
    const rows = await this.prisma.user.findMany({
      where: {
        ...userSearchWhere(q.search),
        ...(status ? { status } : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        email: true,
        displayName: true,
        countryCode: true,
        status: true,
        kycVerified: true,
        createdAt: true,
        roles: { select: { role: true } },
      },
    });
    return rows.map((u) => ({ ...u, roles: u.roles.map((r) => r.role) }));
  }

  async creatorApplications(q: Page & { status?: unknown }) {
    const status = parseEnumFilter(q.status, Object.values(CreatorApplicationStatus), CreatorApplicationStatus.PENDING);
    const before = parseBefore(q.before);
    const rows = await this.prisma.creatorApplication.findMany({
      where: { ...(status ? { status } : {}), ...(before ? { appliedAt: { lt: before } } : {}) },
      orderBy: { appliedAt: 'desc' },
      take: clampLimit(q.limit),
    });
    const names = await this.namesFor([...rows.map((r) => r.userId), ...rows.map((r) => r.reviewedBy)]);
    return rows.map((r) => ({
      ...r,
      user: names.get(r.userId) ?? null,
      reviewer: r.reviewedBy ? (names.get(r.reviewedBy) ?? null) : null,
    }));
  }

  async withdrawals(q: Page & { status?: unknown }) {
    const status = parseEnumFilter(q.status, Object.values(WithdrawalStatus), WithdrawalStatus.PENDING_REVIEW);
    const before = parseBefore(q.before);
    const rows = await this.prisma.withdrawalRequest.findMany({
      where: { ...(status ? { status } : {}), ...(before ? { requestedAt: { lt: before } } : {}) },
      orderBy: { requestedAt: 'desc' },
      take: clampLimit(q.limit),
      select: {
        id: true,
        creatorId: true,
        walletType: true,
        amountMinor: true, // coins — the column name is historical
        currencyCode: true,
        status: true,
        riskFlags: true, // reviewer-only: never returned by the creator-facing history
        grossMinor: true,
        feeMinor: true,
        netMinor: true,
        rateMinorPer100Coins: true,
        payoutTo: true,
        requestedAt: true,
        decidedAt: true,
        failureReason: true,
      },
    });
    const ids = [...new Set(rows.map((r) => r.creatorId))];
    const [names, verifiedNames] = await Promise.all([
      this.namesFor(ids),
      ids.length
        ? this.prisma.kycSubmission.findMany({ where: { userId: { in: ids }, status: 'APPROVED' }, orderBy: { reviewedAt: 'desc' }, select: { userId: true, fullName: true } })
        : Promise.resolve([] as { userId: string; fullName: string }[]),
    ]);
    const verifiedName = new Map<string, string>();
    for (const v of verifiedNames) if (!verifiedName.has(v.userId)) verifiedName.set(v.userId, v.fullName);
    return rows.map(({ amountMinor, payoutTo, ...r }) => {
      const to = (payoutTo ?? {}) as { bankName?: string; accountLast4?: string; accountName?: string };
      return {
        ...r,
        amountCoins: amountMinor,
        // Where it is going — never the provider's recipient code.
        payoutAccount: payoutTo ? { bankName: to.bankName ?? null, accountLast4: to.accountLast4 ?? null, accountName: to.accountName ?? null } : null,
        user: names.get(r.creatorId) ?? null,
        // The legal name an admin approved for this person, to compare with the
        // name on the bank account. Null if they were never verified.
        verifiedName: verifiedName.get(r.creatorId) ?? null,
        payoutNameMatchesVerified: namesMatch(verifiedName.get(r.creatorId), to.accountName),
      };
    });
  }

  async agencies(q: Page & { status?: unknown }) {
    const status = parseEnumFilter(q.status, Object.values(AgencyStatus));
    const before = parseBefore(q.before);
    const rows = await this.prisma.agency.findMany({
      where: { ...(status ? { status } : {}), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(q.limit),
    });
    const [names, members] = await Promise.all([
      this.namesFor(rows.map((r) => r.ownerId)),
      rows.length
        ? this.prisma.agencyMembership.groupBy({
            by: ['agencyId'],
            where: { agencyId: { in: rows.map((r) => r.id) }, status: 'ACTIVE' },
            _count: { _all: true },
          })
        : Promise.resolve([] as { agencyId: string; _count: { _all: number } }[]),
    ]);
    const countById = new Map(members.map((m) => [m.agencyId, m._count._all]));
    return rows.map((r) => ({ ...r, owner: names.get(r.ownerId) ?? null, activeCreators: countById.get(r.id) ?? 0 }));
  }

  async liveSessions(q: Page & { status?: unknown }) {
    const status = parseEnumFilter(q.status, Object.values(LiveStatus), LiveStatus.LIVE);
    const rows = await this.prisma.liveSession.findMany({
      where: status ? { status } : {},
      orderBy: { startedAt: 'desc' },
      take: clampLimit(q.limit),
      select: {
        id: true,
        hostId: true,
        title: true,
        category: true,
        status: true,
        startedAt: true,
        endedAt: true,
        likeCount: true,
        peakViewerCount: true,
        durationSeconds: true,
      },
    });
    const [names, viewers] = await Promise.all([
      this.namesFor(rows.map((r) => r.hostId)),
      rows.length
        ? this.prisma.liveViewer.groupBy({
            by: ['sessionId'],
            where: { sessionId: { in: rows.map((r) => r.id) }, leftAt: null },
            _count: { _all: true },
          })
        : Promise.resolve([] as { sessionId: string; _count: { _all: number } }[]),
    ]);
    const viewersById = new Map(viewers.map((v) => [v.sessionId, v._count._all]));
    return rows.map((r) => ({
      ...r,
      host: names.get(r.hostId) ?? null,
      viewersNow: r.status === LiveStatus.LIVE ? (viewersById.get(r.id) ?? 0) : 0,
    }));
  }

  async purchases(q: Page & { status?: unknown }) {
    const status = parseEnumFilter(q.status, Object.values(PurchaseStatus));
    const before = parseBefore(q.before);
    const rows = await this.prisma.coinPurchase.findMany({
      where: { ...(status ? { status } : {}), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(q.limit),
      select: {
        id: true,
        userId: true,
        provider: true,
        amountMinor: true,
        currencyCode: true,
        coinAmount: true,
        status: true,
        createdAt: true,
        confirmedAt: true,
      },
    });
    const names = await this.namesFor(rows.map((r) => r.userId));
    return rows.map((r) => ({ ...r, user: names.get(r.userId) ?? null }));
  }

  async auditLog(q: Page & { action?: unknown }) {
    const before = parseBefore(q.before);
    const action = typeof q.action === 'string' && q.action.trim() ? q.action.trim() : undefined;
    const rows = await this.prisma.auditLog.findMany({
      where: { ...(action ? { action: { contains: action, mode: 'insensitive' as const } } : {}), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(q.limit),
    });
    const names = await this.namesFor(rows.map((r) => r.actorId));
    return rows.map((r) => ({ ...r, actor: r.actorId ? (names.get(r.actorId) ?? null) : null }));
  }

  async moderationActions(q: Page) {
    const before = parseBefore(q.before);
    const rows = await this.prisma.moderationAction.findMany({
      where: before ? { createdAt: { lt: before } } : {},
      orderBy: { createdAt: 'desc' },
      take: clampLimit(q.limit),
    });
    const names = await this.namesFor([...rows.map((r) => r.actorId), ...rows.map((r) => r.targetUserId)]);
    return rows.map((r) => ({
      ...r,
      actor: names.get(r.actorId) ?? null,
      target: r.targetUserId ? (names.get(r.targetUserId) ?? null) : null,
    }));
  }

  async games() {
    const [games, regions] = await Promise.all([
      this.prisma.gameDefinition.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.gameRegionConfig.groupBy({
        by: ['gameCode'],
        where: { enabled: true },
        _count: { _all: true },
      }),
    ]);
    const enabledRegions = new Map(regions.map((r) => [r.gameCode, r._count._all]));
    return games.map((g) => ({
      code: g.code,
      name: g.name,
      status: g.status,
      version: g.version,
      minAge: g.minAge,
      rules: g.rulesJson ?? {},
      enabledRegions: enabledRegions.get(g.code) ?? 0,
      updatedAt: g.updatedAt,
    }));
  }
}
