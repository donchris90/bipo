import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type SearchAllResult = {
  users: Array<{ id: string; displayName: string | null; countryCode: string; isLive: boolean }>;
  liveRooms: Array<{ id: string; hostId: string; title: string; category: string | null; countryCode: string; viewerCount: number }>;
  partyRooms: Array<{ id: string; hostId: string; title: string; category: string | null; countryCode: string; mode: string }>;
  videos: Array<{ id: string; creatorId: string; title: string; caption: string | null; tag: string | null; thumbnailUrl: string | null; viewCount: number }>;
  teams: Array<{ id: string; name: string; description: string | null; countryCode: string; teamLevel: number }>;
  agencies: Array<{ id: string; name: string; status: string }>;
  games: Array<{ code: string; name: string; status: string }>;
};

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async searchUsers(query: string, limit = 20) {
    if (!query || query.trim().length < 2) return [];
    const q = query.trim();
    const users = await this.prisma.user.findMany({
      where: { OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { email: { startsWith: q, mode: 'insensitive' } }], status: 'ACTIVE' },
      select: { id: true, displayName: true, countryCode: true },
      take: Math.min(limit, 50),
    });
    const live = await this.prisma.liveSession.findMany({ where: { hostId: { in: users.map((u) => u.id) }, status: 'LIVE' }, select: { hostId: true }, distinct: ['hostId'] });
    const liveSet = new Set(live.map((x) => x.hostId));
    return users.map((u) => ({ ...u, isLive: liveSet.has(u.id) }));
  }

  async searchAll(query: string, limit = 8): Promise<SearchAllResult> {
    const q = query.trim();
    if (q.length < 2) return { users: [], liveRooms: [], partyRooms: [], videos: [], teams: [], agencies: [], games: [] };
    const take = Math.min(Math.max(limit, 1), 20);
    const [users, liveSessions, partyRooms, videos, teams, agencies, games] = await Promise.all([
      this.searchUsers(q, take),
      this.prisma.liveSession.findMany({
        where: { status: 'LIVE', OR: [{ title: { contains: q, mode: 'insensitive' } }, { category: { contains: q, mode: 'insensitive' } }] },
        select: { id: true, hostId: true, title: true, category: true, countryCode: true }, take, orderBy: { startedAt: 'desc' },
      }),
      this.prisma.partyRoom.findMany({
        where: { status: 'OPEN', OR: [{ title: { contains: q, mode: 'insensitive' } }, { category: { contains: q, mode: 'insensitive' } }] },
        select: { id: true, hostId: true, title: true, category: true, countryCode: true, mode: true }, take, orderBy: { createdAt: 'desc' },
      }),
      this.prisma.video.findMany({
        where: { status: 'PUBLISHED', OR: [{ title: { contains: q, mode: 'insensitive' } }, { caption: { contains: q, mode: 'insensitive' } }, { tag: { contains: q.replace(/^#/, ''), mode: 'insensitive' } }] },
        select: { id: true, creatorId: true, title: true, caption: true, tag: true, thumbnailUrl: true, viewCount: true }, take, orderBy: [{ viewCount: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.team.findMany({ where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] }, select: { id: true, name: true, description: true, countryCode: true, teamLevel: true }, take, orderBy: { teamXp: 'desc' } }),
      this.prisma.agency.findMany({ where: { status: 'APPROVED', name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true, status: true }, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.gameDefinition.findMany({ where: { status: { not: 'DISABLED' }, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] }, select: { code: true, name: true, status: true }, take, orderBy: { name: 'asc' } }),
    ]);
    const counts = await Promise.all(liveSessions.map((s) => this.prisma.liveViewer.count({ where: { sessionId: s.id, leftAt: null } })));
    return { users, liveRooms: liveSessions.map((s, i) => ({ ...s, viewerCount: counts[i] ?? 0 })), partyRooms, videos, teams, agencies, games };
  }
}
