import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ExperienceService {
  constructor(private readonly prisma: PrismaService) {}

  async passport(userId: string) {
    const [user, hostLevels, badges, teamMember, season, supporters, creatorStats] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, avatarUrl: true, rrydaXp: true, rrydaLevel: true, hostXp: true, hostLevel: true } }),
      this.prisma.hostLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' }, select: { level: true, name: true, xpRequired: true } }),
      this.prisma.userBadge.findMany({ where: { userId }, include: { badge: true }, orderBy: { earnedAt: 'desc' }, take: 30 }),
      this.prisma.teamMember.findUnique({ where: { userId }, include: { team: { select: { id: true, name: true, teamLevel: true, teamXp: true, themeColor: true } } } }),
      this.prisma.season.findFirst({ where: { startsAt: { lte: new Date() }, endsAt: { gt: new Date() } }, orderBy: { startsAt: 'desc' } }),
      this.prisma.creatorSupporter.findMany({ where: { supporterId: userId }, orderBy: { totalGiftCoins: 'desc' }, take: 5, select: { creatorId: true, level: true, totalGiftCoins: true } }),
      this.prisma.giftTransaction.aggregate({ where: { recipientId: userId }, _sum: { coinAmount: true }, _count: { id: true } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    let seasonResult: any = null;
    if (season) {
      const row = await this.prisma.seasonParticipant.findUnique({ where: { seasonId_userId: { seasonId: season.id, userId } } });
      const rank = row ? (await this.prisma.seasonParticipant.count({ where: { seasonId: season.id, points: { gt: row.points } } }) + 1) : null;
      seasonResult = { id: season.id, name: season.name, points: row?.points ?? 0, rank };
    }
    return {
      identity: { level: user.rrydaLevel, xp: user.rrydaXp },
      creator: user.hostLevel > 1 || user.hostXp > 0 ? { level: user.hostLevel, xp: user.hostXp, name: [...hostLevels].reverse().find((l) => l.xpRequired <= user.hostXp)?.name ?? 'New Host' } : null,
      team: teamMember ? { id: teamMember.team.id, name: teamMember.team.name, role: teamMember.role, level: teamMember.team.teamLevel, xp: teamMember.team.teamXp, themeColor: teamMember.team.themeColor, contributionXp: teamMember.xp } : null,
      season: seasonResult,
      badges: badges.map((b) => ({ key: b.badge.key, label: b.badge.label, emoji: b.badge.emoji, earnedAt: b.earnedAt })),
      supporter: { creatorsSupported: supporters.length, topRelationships: supporters },
      creatorStats: { receivedGiftCoins: creatorStats._sum.coinAmount ?? 0, giftCount: creatorStats._count.id },
    };
  }

  async creatorCareer(userId: string) {
    const [user, levels, sessions, gifts, followers, videos] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { hostXp: true, hostLevel: true, roles: { select: { role: true } } } }),
      this.prisma.hostLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
      this.prisma.liveSession.aggregate({ where: { hostId: userId, status: 'ENDED' }, _count: { id: true }, _sum: { durationSeconds: true, peakViewerCount: true } }),
      this.prisma.giftTransaction.aggregate({ where: { recipientId: userId }, _sum: { coinAmount: true }, _count: { id: true } }),
      this.prisma.follow.count({ where: { followingId: userId } }),
      this.prisma.video.count({ where: { creatorId: userId } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    const creator = user.roles.some((r) => r.role === 'CREATOR');
    if (!creator) return { eligible: false, reason: 'CREATOR_ROLE_REQUIRED' };
    const current = [...levels].reverse().find((l) => l.xpRequired <= user.hostXp) ?? levels[0] ?? { level: 1, name: 'New Host', xpRequired: 0, unlocks: [] };
    const next = levels.find((l) => l.xpRequired > user.hostXp) ?? null;
    return {
      eligible: true,
      career: { level: current.level, name: current.name, xp: user.hostXp, nextLevel: next ? { level: next.level, name: next.name, xpRequired: next.xpRequired, remainingXp: next.xpRequired - user.hostXp } : null },
      milestones: { liveSessions: sessions._count.id, liveSeconds: sessions._sum.durationSeconds ?? 0, peakViewerTotal: sessions._sum.peakViewerCount ?? 0, receivedGiftCoins: gifts._sum.coinAmount ?? 0, giftCount: gifts._count.id, followers, videos },
      nextActions: [
        next ? `Earn ${(next.xpRequired - user.hostXp).toLocaleString()} more Host XP` : 'Maintain your creator streak',
        'Build repeat viewers and Fan Club members',
        'Complete live and community missions',
        'Participate in PKs and seasonal events',
      ],
    };
  }

  async moments(userId: string, limit = 30) {
    return this.prisma.rrydaMoment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: Math.min(50, Math.max(1, Math.floor(limit) || 30)) });
  }

  async globalMoments(limit = 30) {
    return this.prisma.rrydaMoment.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(50, Math.max(1, Math.floor(limit) || 30)) });
  }

  // Personalized Moments discovery. This is deliberately deterministic and
  // uses signals already stored by Rryda: follows, gifts, video likes, linked
  // video engagement, moment type and freshness. It does not pretend to have
  // watch-time/ML signals that are not persisted yet.
  async discoverMoments(userId: string, limit = 30) {
    const take = Math.min(50, Math.max(1, Math.floor(limit) || 30));
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [me, blocks, follows, gifts, likedVideos, moments] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } }),
      this.prisma.block.findMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] }, select: { blockerId: true, blockedId: true } }),
      this.prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
      this.prisma.giftTransaction.groupBy({ by: ['recipientId'], where: { senderId: userId, createdAt: { gte: since } }, _sum: { coinAmount: true } }),
      this.prisma.videoLike.findMany({ where: { userId }, select: { videoId: true }, take: 5000 }),
      this.prisma.rrydaMoment.findMany({ orderBy: { createdAt: 'desc' }, take: 250 }),
    ]);
    if (!me || moments.length === 0) return [];

    const blocked = new Set(blocks.map((b) => b.blockerId === userId ? b.blockedId : b.blockerId));
    const followed = new Set(follows.map((f) => f.followingId));
    const giftAffinity = new Map(gifts.map((g) => [g.recipientId, Number(g._sum.coinAmount ?? 0)]));
    const likedVideoIds = new Set(likedVideos.map((v) => v.videoId));
    const videoIds = moments.flatMap((m) => {
      const payload = m.payload as any;
      return payload && typeof payload.videoId === 'string' ? [payload.videoId] : [];
    });
    const [videos, creators] = await Promise.all([
      videoIds.length ? this.prisma.video.findMany({ where: { id: { in: videoIds } }, select: { id: true, creatorId: true, viewCount: true, likeCount: true, shareCount: true, countryCode: true, createdAt: true } }) : [],
      this.prisma.user.findMany({ where: { id: { in: [...new Set(moments.map((m) => m.userId))] } }, select: { id: true, countryCode: true } }),
    ]);
    const videoById = new Map(videos.map((v) => [v.id, v]));
    const creatorById = new Map(creators.map((c) => [c.id, c]));
    const typeWeight: Record<string, number> = { GIFT_MILESTONE: 14, PK_MOMENT: 12 };
    const now = Date.now();

    const ranked = moments
      .filter((m) => !blocked.has(m.userId) && m.userId !== userId)
      .map((m) => {
        const payload = m.payload as any;
        const video = payload && typeof payload.videoId === 'string' ? videoById.get(payload.videoId) : undefined;
        const creator = creatorById.get(m.userId);
        const ageDays = Math.max(0, (now - m.createdAt.getTime()) / 86400000);
        const freshness = Math.max(0, 30 - ageDays) * 1.8;
        const affinity = (followed.has(m.userId) ? 28 : 0) + Math.log1p(giftAffinity.get(m.userId) ?? 0) * 10;
        const country = creator?.countryCode?.toUpperCase() === me.countryCode?.toUpperCase() ? 4 : 0;
        const engagement = video ? Math.log1p(video.viewCount) * 2 + Math.log1p(video.likeCount) * 5 + Math.log1p(video.shareCount) * 8 + (likedVideoIds.has(video.id) ? 12 : 0) : 0;
        const type = typeWeight[m.type] ?? 4;
        return { moment: m, score: freshness + affinity + country + engagement + type };
      })
      .sort((a, b) => b.score - a.score || b.moment.createdAt.getTime() - a.moment.createdAt.getTime())
      .slice(0, take);

    return ranked.map(({ moment }) => moment);
  }
}
