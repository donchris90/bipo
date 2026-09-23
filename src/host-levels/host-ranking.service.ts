import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HostRankingService {
  constructor(private readonly prisma: PrismaService) {}

  async ranking(limit = 50) {
    const safeLimit = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 20));
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', roles: { some: { role: 'CREATOR' } } },
      orderBy: [{ hostLevel: 'desc' }, { hostXp: 'desc' }, { createdAt: 'asc' }],
      take: safeLimit,
      select: { id: true, displayName: true, countryCode: true, avatarUrl: true, hostXp: true, hostLevel: true },
    });
    return users.map((u, index) => ({
      rank: index + 1,
      userId: u.id,
      displayName: u.displayName,
      countryCode: u.countryCode,
      avatarUrl: u.avatarUrl,
      hostXp: u.hostXp,
      hostLevel: u.hostLevel,
      achievement: this.achievementForLevel(u.hostLevel),
    }));
  }

  async achievements(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { hostXp: true, hostLevel: true } });
    if (!user) return [];
    const definitions = [
      { key: 'FIRST_HOST', label: 'First Host', description: 'Reach Host Level 2', level: 2 },
      { key: 'RISING_HOST', label: 'Rising Host', description: 'Reach Host Level 3', level: 3 },
      { key: 'PRO_HOST', label: 'Pro Host', description: 'Reach Host Level 5', level: 5 },
      { key: 'ELITE_HOST', label: 'Elite Host', description: 'Reach Host Level 10', level: 10 },
    ];
    return definitions.map((a) => ({ ...a, unlocked: user.hostLevel >= a.level }));
  }

  private achievementForLevel(level: number) {
    if (level >= 10) return 'Elite Host';
    if (level >= 5) return 'Pro Host';
    if (level >= 3) return 'Rising Host';
    if (level >= 2) return 'First Host';
    return 'New Host';
  }
}
