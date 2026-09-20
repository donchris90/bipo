import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Spec §8 lists username/creator/room/game/hashtag search, with voice/AI
// search later. Only "username/displayName" is meaningful right now — Live,
// rooms, and games don't exist yet in this codebase, so this deliberately
// does not stub search surfaces for content that isn't buildable yet.
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async searchUsers(query: string, limit = 20) {
    if (!query || query.trim().length < 2) return [];
    return this.prisma.user.findMany({
      where: {
        OR: [
          { displayName: { contains: query, mode: 'insensitive' } },
          { email: { startsWith: query, mode: 'insensitive' } },
        ],
        status: 'ACTIVE',
      },
      select: { id: true, displayName: true, countryCode: true },
      take: Math.min(limit, 50),
    });
  }
}
