import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoleName } from '@prisma/client';

const MAX_INTERESTS = 10;
const RECENT_LIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// First-run flow: pick a few interests, follow a few people, done. Only needs PrismaService, so
// the module has no imports and nothing can form a cycle with it.
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async listInterests() {
    return this.prisma.interest.findMany({ where: { active: true } });
  }

  // Lets the app resume mid-flow (killed on step 1, reopened) instead of restarting blind.
  async status(userId: string) {
    const [user, picked] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { onboardedAt: true } }),
      this.prisma.userInterest.findMany({ where: { userId }, select: { interestKey: true } }),
    ]);
    return { completed: !!user?.onboardedAt, interests: picked.map((p) => p.interestKey) };
  }

  // Replaces the whole selection atomically. At least one, and a small cap — past a handful an
  // interest stops being a useful signal.
  async setInterests(userId: string, keys: unknown) {
    if (!Array.isArray(keys) || keys.length === 0) throw new BadRequestException('Pick at least one interest');
    const unique = [...new Set(keys.map((k) => String(k)))];
    if (unique.length > MAX_INTERESTS) throw new BadRequestException(`Pick at most ${MAX_INTERESTS} interests`);

    const valid = await this.prisma.interest.findMany({ where: { key: { in: unique }, active: true }, select: { key: true } });
    const validKeys = new Set(valid.map((v) => v.key));
    const unknown = unique.filter((k) => !validKeys.has(k));
    if (unknown.length > 0) throw new BadRequestException(`Unknown interest(s): ${unknown.join(', ')}`);

    await this.prisma.$transaction(async (tx) => {
      await tx.userInterest.deleteMany({ where: { userId } });
      for (const key of unique) await tx.userInterest.create({ data: { userId, interestKey: key } });
    });
    return { interests: unique };
  }

  // Creators who recently went live in a category matching what this person picked come first
  // (LiveSession.category is free text, so it's a case-insensitive "contains" on the interest
  // label — an honest approximation, not a taxonomy). The list is then filled with the biggest
  // creators overall. Never includes the user or anyone they already follow.
  async suggestedCreators(userId: string, limit = 10) {
    const safeLimit = Math.min(30, Math.max(1, Math.floor(Number(limit)) || 10));
    const [following, picked] = await Promise.all([
      this.prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
      this.prisma.userInterest.findMany({ where: { userId }, include: { interest: { select: { label: true } } } }),
    ]);
    const excludeIds = [userId, ...following.map((f) => f.followingId)];
    const select = { id: true, displayName: true, avatarUrl: true, bio: true, hostLevel: true } as const;
    const creatorWhere = { id: { notIn: excludeIds }, roles: { some: { role: RoleName.CREATOR } } };

    let matched: Array<{ id: string; displayName: string | null; avatarUrl: string | null; bio: string | null; hostLevel: number }> = [];
    const labels = picked.map((p) => p.interest.label);
    if (labels.length > 0) {
      const since = new Date(Date.now() - RECENT_LIVE_WINDOW_MS);
      const sessions = await this.prisma.liveSession.findMany({
        where: { startedAt: { gte: since }, OR: labels.map((label) => ({ category: { contains: label, mode: 'insensitive' as const } })) },
        select: { hostId: true },
        take: 200,
      });
      const hostIds = [...new Set(sessions.map((s) => s.hostId))];
      if (hostIds.length > 0) {
        matched = await this.prisma.user.findMany({
          where: { ...creatorWhere, id: { in: hostIds, notIn: excludeIds } },
          orderBy: { hostXp: 'desc' },
          take: safeLimit,
          select,
        });
      }
    }

    if (matched.length >= safeLimit) return matched;
    const matchedIds = matched.map((m) => m.id);
    const filler = await this.prisma.user.findMany({
      where: { ...creatorWhere, id: { notIn: [...excludeIds, ...matchedIds] } },
      orderBy: { hostXp: 'desc' },
      take: safeLimit - matched.length,
      select,
    });
    return [...matched, ...filler];
  }

  // Idempotent: a retried request (flaky network) must not be treated as a failure.
  async complete(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { onboardedAt: true } });
    if (user?.onboardedAt) return { onboardedAt: user.onboardedAt };
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { onboardedAt: new Date() }, select: { onboardedAt: true } });
    return { onboardedAt: updated.onboardedAt };
  }
}
