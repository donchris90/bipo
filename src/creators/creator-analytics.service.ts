import { BadRequestException, Injectable } from '@nestjs/common';
import { WalletType, LedgerEntryType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_DAY_OFFSET_MINUTES, monthPeriod, secondsPerDay } from '../common/day-period';

export type AnalyticsPeriod = 'today' | 'week' | 'month' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling lookback windows, not calendar-aligned buckets — same choice (and
// same reason) as GiftService.ranking(): "today" is the last 24 hours, so a
// creator who streams across midnight isn't split across two days and
// timezones don't change the answer.
export function periodStart(period: AnalyticsPeriod, now = Date.now()): Date {
  switch (period) {
    case 'today':
      return new Date(now - DAY_MS);
    case 'week':
      return new Date(now - 7 * DAY_MS);
    case 'month':
      return new Date(now - 30 * DAY_MS);
    case 'all':
      return new Date(0);
  }
}

export function parsePeriod(raw: string | undefined, fallback: AnalyticsPeriod = 'week'): AnalyticsPeriod {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'today' || raw === 'week' || raw === 'month' || raw === 'all') return raw;
  throw new BadRequestException("period must be 'today', 'week', 'month' or 'all'");
}

// Seconds of [start, end) that fall inside [windowStart, windowEnd). Pure and
// exported so the clipping arithmetic has a direct test.
export function overlapSeconds(start: Date, end: Date, windowStart: Date, windowEnd: Date): number {
  const from = Math.max(start.getTime(), windowStart.getTime());
  const to = Math.min(end.getTime(), windowEnd.getTime());
  return Math.max(0, Math.round((to - from) / 1000));
}

// Everything here is derived from rows that already exist (LiveSession,
// Follow, GiftTransaction, LedgerEntry, PKBattle) — no schema change and no
// second source of truth to drift.
@Injectable()
export class CreatorAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private dayOffsetMinutes(): number {
    const raw = this.config.get<string>('MISSION_DAY_OFFSET_MINUTES');
    if (raw === undefined || raw === '') return DEFAULT_DAY_OFFSET_MINUTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_DAY_OFFSET_MINUTES;
  }

  // Days this calendar month on which the creator broadcast at least
  // `thresholdMinutes` in total. There is deliberately no target number here:
  // the platform hasn't defined how many valid days a month should take, so
  // reporting a "x / 20" would be inventing one.
  async validLiveDays(userId: string, now = new Date(), thresholdMinutes = 60) {
    const month = monthPeriod(now, this.dayOffsetMinutes());
    const sessions = await this.prisma.liveSession.findMany({
      where: {
        hostId: userId,
        startedAt: { not: null, lt: month.end },
        OR: [{ status: 'LIVE' }, { endedAt: { gte: month.start } }],
      },
      select: { startedAt: true, endedAt: true },
      take: 1000,
    });
    const perDay = secondsPerDay(
      sessions.filter((s) => s.startedAt).map((s) => ({ start: s.startedAt as Date, end: s.endedAt ?? now })),
      month.start,
      month.end,
      this.dayOffsetMinutes(),
    );
    const count = [...perDay.values()].filter((seconds) => seconds >= thresholdMinutes * 60).length;
    return { count, thresholdMinutes, month: month.key };
  }

  async dashboard(userId: string, period: AnalyticsPeriod) {
    const now = new Date();
    const since = periodStart(period, now.getTime());

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_type: { userId, type: WalletType.CREATOR_EARNINGS } },
      select: { id: true, balance: true },
    });

    const [
      sessions,
      followerTotal,
      followersGained,
      giftAgg,
      topGifterRows,
      giftEarnedAgg,
      privateEarnedAgg,
      pk,
      validDays,
    ] = await Promise.all([
      // Sessions that could overlap the window: still live, or ended after it began.
      this.prisma.liveSession.findMany({
        where: {
          hostId: userId,
          startedAt: { not: null },
          OR: [{ status: 'LIVE' }, { endedAt: { gte: since } }],
        },
        select: { startedAt: true, endedAt: true, likeCount: true, peakViewerCount: true },
        take: 1000,
      }),
      this.prisma.follow.count({ where: { followingId: userId } }),
      this.prisma.follow.count({ where: { followingId: userId, createdAt: { gte: since } } }),
      this.prisma.giftTransaction.aggregate({
        where: { recipientId: userId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { coinAmount: true },
      }),
      this.prisma.giftTransaction.groupBy({
        by: ['senderId'],
        where: { recipientId: userId, createdAt: { gte: since } },
        _sum: { coinAmount: true },
        orderBy: { _sum: { coinAmount: 'desc' } },
        take: 3,
      }),
      wallet
        ? this.prisma.ledgerEntry.aggregate({
            where: { walletId: wallet.id, type: LedgerEntryType.GIFT_RECEIVED, createdAt: { gte: since } },
            _sum: { amount: true },
          })
        : Promise.resolve({ _sum: { amount: null as bigint | null } }),
      wallet
        ? this.prisma.ledgerEntry.aggregate({
            where: { walletId: wallet.id, type: LedgerEntryType.PRIVATE_LIVE_PAYMENT, createdAt: { gte: since } },
            _sum: { amount: true },
          })
        : Promise.resolve({ _sum: { amount: null as bigint | null } }),
      this.pkRecord(userId, since),
      this.validLiveDays(userId, now),
    ]);

    let liveSeconds = 0;
    let liveLikes = 0;
    let peakViewers = 0;
    for (const s of sessions) {
      if (!s.startedAt) continue;
      liveSeconds += overlapSeconds(s.startedAt, s.endedAt ?? now, since, now);
      liveLikes += s.likeCount;
      peakViewers = Math.max(peakViewers, s.peakViewerCount);
    }

    const gifterIds = topGifterRows.map((g) => g.senderId);
    const gifters = gifterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: gifterIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(gifters.map((u) => [u.id, u.displayName]));

    return {
      period,
      since,
      // Kept from the original endpoint so existing clients don't break.
      withdrawableBalance: (wallet?.balance ?? 0n).toString(),
      live: {
        seconds: liveSeconds,
        sessions: sessions.length,
        likes: liveLikes,
        peakViewers,
      },
      followers: { total: followerTotal, gained: followersGained },
      gifts: {
        count: giftAgg._count._all,
        // Gross coins senders paid for gifts sent to this creator.
        coins: giftAgg._sum.coinAmount ?? 0,
        topGifters: topGifterRows.map((g) => ({
          userId: g.senderId,
          displayName: nameById.get(g.senderId) ?? null,
          coins: g._sum.coinAmount ?? 0,
        })),
      },
      // This creator's own share, after the platform (and any agency) split.
      earnings: {
        creatorCoins: ((giftEarnedAgg._sum.amount ?? 0n) + (privateEarnedAgg._sum.amount ?? 0n)).toString(),
        giftCoins: (giftEarnedAgg._sum.amount ?? 0n).toString(),
        privateCoins: (privateEarnedAgg._sum.amount ?? 0n).toString(),
      },
      pk,
      // Independent of `period`: always the current calendar month.
      validDays,
    };
  }

  private async pkRecord(userId: string, since: Date) {
    const mine = {
      status: 'SETTLED' as const,
      settledAt: { gte: since },
      OR: [{ challengerId: userId }, { opponentId: userId }],
    };
    const [wins, losses, draws] = await Promise.all([
      this.prisma.pKBattle.count({ where: { ...mine, winnerId: userId } }),
      this.prisma.pKBattle.count({
        where: { ...mine, AND: [{ winnerId: { not: null } }, { winnerId: { not: userId } }] },
      }),
      this.prisma.pKBattle.count({ where: { ...mine, winnerId: null } }),
    ]);
    return { wins, losses, draws };
  }

  // Top gift recipients in the window, enriched with follower count and PK
  // wins. Ranked by gross coins received, the same measure as the Honor
  // ranking, so the two never disagree about who is ahead.
  async leaderboard(viewerId: string, period: AnalyticsPeriod, limit = 20) {
    const take = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
    const since = periodStart(period);

    const grouped = await this.prisma.giftTransaction.groupBy({
      by: ['recipientId'],
      where: { createdAt: { gte: since } },
      _sum: { coinAmount: true },
      orderBy: { _sum: { coinAmount: 'desc' } },
      take,
    });
    if (grouped.length === 0) return [];

    const ids = grouped.map((g) => g.recipientId);
    const [users, followerCounts, pkWinCounts] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true, countryCode: true },
      }),
      this.prisma.follow.groupBy({
        by: ['followingId'],
        where: { followingId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.pKBattle.groupBy({
        by: ['winnerId'],
        where: { status: 'SETTLED', settledAt: { gte: since }, winnerId: { in: ids } },
        _count: { _all: true },
      }),
    ]);

    const userById = new Map(users.map((u) => [u.id, u]));
    const followersById = new Map(followerCounts.map((f) => [f.followingId, f._count._all]));
    const winsById = new Map(pkWinCounts.map((p) => [p.winnerId as string, p._count._all]));

    // A recipient deleted since receiving gifts is dropped (as in
    // GiftService.ranking), so ranks are assigned after that filter and
    // stay contiguous.
    return grouped
      .filter((g) => userById.has(g.recipientId))
      .map((g, index) => {
        const u = userById.get(g.recipientId)!;
        return {
          rank: index + 1,
          userId: u.id,
          displayName: u.displayName,
          countryCode: u.countryCode,
          giftCoins: g._sum.coinAmount ?? 0,
          followers: followersById.get(u.id) ?? 0,
          pkWins: winsById.get(u.id) ?? 0,
          isMe: u.id === viewerId,
        };
      });
  }
}
