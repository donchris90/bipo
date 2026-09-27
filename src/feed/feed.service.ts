import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Spec §6/§7 describes a full Home (For You / Following / Live Now /
// Trending) with a multi-signal discovery engine (watch_time, engagement,
// retention, safety score, etc.). None of those signals exist yet — there's
// no Live, no watch sessions, no engagement data. Building a "ranking
// engine" against data that doesn't exist yet would just be fake numbers.
// This is the honest slice: who you follow, and a crude follower-count
// discovery list to bootstrap the graph. Replace `discover`'s ranking once
// Phase 3 (Live) produces real engagement signals.
@Injectable()
export class FeedService {
  constructor(private readonly prisma: PrismaService) {}

  // The one real-time signal Home actually has: does this user currently
  // have a LiveSession row with status LIVE. Two-step (fetch ids, then a
  // second query) rather than a relation-based include — same
  // no-relations-between-domains pattern as Follow/Block/GameEntry
  // elsewhere in this schema, so User has no `liveSessions` relation to
  // join through.
  private async attachLiveStatus<T extends { id: string }>(users: T[]): Promise<(T & { isLive: boolean })[]> {
    if (users.length === 0) return [];
    const liveHostIds = await this.prisma.liveSession.findMany({
      where: { hostId: { in: users.map((u) => u.id) }, status: 'LIVE' },
      select: { hostId: true },
    });
    const liveSet = new Set(liveHostIds.map((r) => r.hostId));
    return users.map((u) => ({ ...u, isLive: liveSet.has(u.id) }));
  }

  async following(userId: string) {
    const rows = await this.prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true },
    });
    const ids = rows.map((r) => r.followingId);
    if (ids.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, countryCode: true },
    });
    return this.attachLiveStatus(users);
  }

  // Home's primary surface: real LiveSession rows (status LIVE), not a
  // ranked/personalized feed — there's no watch-time or viewer-count
  // signal to rank by (see `discover`'s comment below), so this is
  // ordered by most-recently-started, honestly. Joins host displayName/
  // countryCode the same two-step way as attachLiveStatus, since
  // LiveSession has no relation to User.
  // Who's live now, hottest first: most people watching, then newest. Each
  // card also carries the live viewer count and whether the host is in a PK
  // (both shown on the card, like BIGO/Poppo). The live viewer screen uses
  // this same order for swiping up/down between lives.
  async liveNow(limit = 50) {
    const sessions = await this.prisma.liveSession.findMany({
      where: { status: 'LIVE' },
      orderBy: { startedAt: 'desc' },
      take: 200,
      select: { id: true, hostId: true, title: true, category: true, coverUrl: true, countryCode: true, startedAt: true, privacy: true },
    });
    if (sessions.length === 0) return [];

    const hostIds = sessions.map((s) => s.hostId);
    const [hosts, counts, battles] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: hostIds } },
        select: { id: true, displayName: true, avatarUrl: true },
      }),
      this.prisma.liveViewer.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: sessions.map((s) => s.id) }, leftAt: null },
        _count: { _all: true },
      }),
      this.prisma.pKBattle.findMany({
        where: { status: { in: ['COUNTDOWN', 'ACTIVE'] }, OR: [{ challengerId: { in: hostIds } }, { opponentId: { in: hostIds } }] },
        select: { challengerId: true, opponentId: true },
      }),
    ]);
    const hostById = new Map(hosts.map((h) => [h.id, h]));
    const countBySession = new Map(counts.map((c) => [c.sessionId, c._count._all]));
    const inPk = new Set(battles.flatMap((b) => [b.challengerId, b.opponentId]));

    return sessions
      .map((s) => ({
        id: s.id,
        hostId: s.hostId,
        hostDisplayName: hostById.get(s.hostId)?.displayName ?? null,
        // The card's thumbnail is the host's chosen cover, or failing that their
        // profile photo.
        hostAvatarUrl: hostById.get(s.hostId)?.avatarUrl ?? null,
        title: s.title,
        category: s.category,
        coverUrl: s.coverUrl,
        countryCode: s.countryCode,
        startedAt: s.startedAt,
        privacy: s.privacy,
        viewerCount: countBySession.get(s.id) ?? 0,
        inPk: inPk.has(s.hostId),
      }))
      .sort((a, b) => b.viewerCount - a.viewerCount || (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async discover(userId: string, limit = 20) {
    const [alreadyFollowing, blockedEither] = await Promise.all([
      this.prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
      this.prisma.block.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
      }),
    ]);

    const exclude = new Set<string>([
      userId,
      ...alreadyFollowing.map((f) => f.followingId),
      ...blockedEither.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)),
    ]);

    const grouped = await this.prisma.follow.groupBy({
      by: ['followingId'],
      _count: { followingId: true },
      orderBy: { _count: { followingId: 'desc' } },
      take: limit + exclude.size, // over-fetch since we filter after grouping
    });

    const candidateIds = grouped.map((g) => g.followingId).filter((id) => !exclude.has(id));
    const topIds = candidateIds.slice(0, limit);
    if (topIds.length === 0) {
      // No follow graph yet — fall back to most recently active accounts
      // rather than returning nothing.
      const recent = await this.prisma.user.findMany({
        where: { id: { notIn: Array.from(exclude) }, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, displayName: true, countryCode: true },
        take: limit,
      });
      return this.attachLiveStatus(recent);
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: topIds } },
      select: { id: true, displayName: true, countryCode: true },
    });
    // Preserve the follower-count ranking order from `grouped`.
    const order = new Map<string, number>(topIds.map((id: string, i: number) => [id, i]));
    const sorted = users.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return this.attachLiveStatus(sorted);
  }

  // "For You" uses signals that actually exist in the database. It is deliberately
  // a transparent weighted rank, not an opaque/fake ML score: creator popularity
  // (followers + video engagement + live peak viewers), direct affinity (gifts),
  // country affinity and freshness all contribute. Watch-time is not included
  // because this schema does not store per-user watch duration.
  async forYou(userId: string, limit = 20) {
    const [me, blockedEither, following, candidates] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } }),
      this.prisma.block.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
      }),
      this.prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
      this.prisma.user.findMany({
        where: { status: 'ACTIVE', NOT: { id: userId } },
        select: { id: true, displayName: true, countryCode: true, createdAt: true },
        take: Math.min(Math.max(limit * 8, 80), 300),
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (!me) return [];
    const blocked = new Set(blockedEither.map((b) => b.blockerId === userId ? b.blockedId : b.blockerId));
    const followed = new Set(following.map((f) => f.followingId));
    const pool = candidates.filter((u) => !blocked.has(u.id) && !followed.has(u.id));
    if (!pool.length) return [];
    const ids = pool.map((u) => u.id);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [followerCounts, giftedTo, videoEngagement, liveStats, liveRows] = await Promise.all([
      this.prisma.follow.groupBy({ by: ['followingId'], where: { followingId: { in: ids } }, _count: { followingId: true } }),
      this.prisma.giftTransaction.groupBy({ by: ['recipientId'], where: { senderId: userId, recipientId: { in: ids }, createdAt: { gte: since } }, _sum: { coinAmount: true } }),
      this.prisma.video.groupBy({ by: ['creatorId'], where: { creatorId: { in: ids }, status: 'PUBLISHED', createdAt: { gte: since } }, _sum: { viewCount: true, likeCount: true, shareCount: true } }),
      this.prisma.liveSession.groupBy({ by: ['hostId'], where: { hostId: { in: ids }, createdAt: { gte: since } }, _sum: { peakViewerCount: true, likeCount: true } }),
      this.prisma.liveSession.findMany({ where: { hostId: { in: ids }, status: 'LIVE' }, select: { hostId: true }, distinct: ['hostId'] }),
    ]);
    const followers = new Map(followerCounts.map((r) => [r.followingId, r._count.followingId]));
    const gifts = new Map(giftedTo.map((r) => [r.recipientId, Number(r._sum.coinAmount ?? 0)]));
    const videos = new Map(videoEngagement.map((r) => [r.creatorId, Number(r._sum.viewCount ?? 0) + Number(r._sum.likeCount ?? 0) * 4 + Number(r._sum.shareCount ?? 0) * 8]));
    const lives = new Map(liveStats.map((r) => [r.hostId, Number(r._sum.peakViewerCount ?? 0) + Number(r._sum.likeCount ?? 0) * 2]));
    const live = new Set(liveRows.map((r) => r.hostId));
    const now = Date.now();

    const ranked = pool.map((u) => {
      const ageDays = Math.max(0, (now - u.createdAt.getTime()) / 86400000);
      const freshness = Math.max(0, 30 - ageDays) * 1.5;
      const popularity = Math.log1p(followers.get(u.id) ?? 0) * 12 + Math.log1p(videos.get(u.id) ?? 0) * 4 + Math.log1p(lives.get(u.id) ?? 0) * 5;
      const affinity = Math.log1p(gifts.get(u.id) ?? 0) * 18;
      const country = u.countryCode.toUpperCase() === me.countryCode.toUpperCase() ? 6 : 0;
      const liveBoost = live.has(u.id) ? 14 : 0;
      return { user: u, score: popularity + affinity + freshness + country + liveBoost };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    return ranked.map(({ user }) => ({ id: user.id, displayName: user.displayName, countryCode: user.countryCode, isLive: live.has(user.id) }));
  }

  // "New" — real and distinct from Discover: literally the most recently
  // registered accounts, not a fallback for "no data yet." Same
  // self/blocked exclusion as discover, no follower-count re-sorting
  // since recency is the entire point of this tab.
  async newUsers(userId: string, limit = 20) {
    const blockedEither = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const exclude = new Set<string>([
      userId,
      ...blockedEither.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)),
    ]);

    const users = await this.prisma.user.findMany({
      where: { id: { notIn: Array.from(exclude) }, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, displayName: true, countryCode: true },
      take: limit,
    });
    return this.attachLiveStatus(users);
  }

  // "Nearby" — real and distinct: same-country accounts, ordered by
  // recency. "Nearby" is a stand-in for actual geolocation (which this
  // app has never collected — only countryCode, set at registration) —
  // this is honest about being country-level, not GPS-level, proximity.
  async nearby(userId: string, countryCode: string, limit = 20) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { nearbyEnabled: true, nearbyLat: true, nearbyLon: true } });
    if (!me?.nearbyEnabled || me.nearbyLat == null || me.nearbyLon == null) return [];

    const blockedEither = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const exclude = new Set<string>([userId, ...blockedEither.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId))]);
    const freshness = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const users = await this.prisma.user.findMany({
      where: { id: { notIn: Array.from(exclude) }, status: 'ACTIVE', countryCode, nearbyEnabled: true, nearbyLat: { not: null }, nearbyLon: { not: null }, nearbyUpdatedAt: { gte: freshness } },
      orderBy: { nearbyUpdatedAt: 'desc' },
      take: 250,
      select: { id: true, displayName: true, countryCode: true, avatarUrl: true, nearbyLat: true, nearbyLon: true, nearbyUpdatedAt: true },
    });
    const earthKm = 6371;
    const rad = (v: number) => (v * Math.PI) / 180;
    const ranked = users.map((u) => {
      const dLat = rad((u.nearbyLat as number) - me.nearbyLat!);
      const dLon = rad((u.nearbyLon as number) - me.nearbyLon!);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(me.nearbyLat!)) * Math.cos(rad(u.nearbyLat as number)) * Math.sin(dLon / 2) ** 2;
      const distanceKm = earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
      return { id: u.id, displayName: u.displayName, countryCode: u.countryCode, avatarUrl: u.avatarUrl, distanceKm: Math.round(distanceKm * 10) / 10, isLive: false };
    }).filter((u) => u.distanceKm <= 100).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, Math.min(50, Math.max(1, limit)));
    const live = await this.prisma.liveSession.findMany({ where: { hostId: { in: ranked.map((u) => u.id) }, status: 'LIVE' }, select: { hostId: true } });
    const liveSet = new Set(live.map((x) => x.hostId));
    return ranked.map((u) => ({ ...u, isLive: liveSet.has(u.id) }));
  }
}
