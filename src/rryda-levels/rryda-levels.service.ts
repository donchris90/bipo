import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

// Rryda Identity: every user's level, independent of HostLevel (creator-only, gates creator
// features). This one gates nothing — it exists so that everything a user does across the app
// (missions, checking in, meeting people, supporting creators) adds up to one visible number,
// instead of only a host's broadcasting activity mattering.
//
// Architecture deliberately mirrors HostLevelsService: a small admin-configurable level table
// (RrydaLevel) plus addXp() incrementing xp and recomputing the level, notifying once on level-up.
@Injectable()
export class RrydaLevelsService {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  async list() {
    return this.prisma.rrydaLevel.findMany({ orderBy: { level: 'asc' } });
  }

  async progress(userId: string) {
    const [user, levels] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { rrydaXp: true, rrydaLevel: true } }),
      this.prisma.rrydaLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
    ]);
    if (!user) throw new NotFoundException('User not found');

    const fallback = { level: 1, name: 'New to Rryda', xpRequired: 0, badgeUrl: null as string | null };
    const reached = levels.filter((l) => l.xpRequired <= user.rrydaXp);
    const current = reached[reached.length - 1] ?? levels[0] ?? fallback;
    const next = levels.find((l) => l.xpRequired > user.rrydaXp) ?? null;

    return {
      xp: user.rrydaXp,
      level: current.level,
      name: current.name,
      badgeUrl: current.badgeUrl,
      nextLevel: next ? { level: next.level, name: next.name, xpRequired: next.xpRequired } : null,
      progressXp: next ? Math.max(0, user.rrydaXp - current.xpRequired) : 0,
      requiredForNext: next ? Math.max(0, next.xpRequired - current.xpRequired) : 0,
      remainingXp: next ? Math.max(0, next.xpRequired - user.rrydaXp) : 0,
    };
  }

  // Adds XP for ANY user (not gated to creators, unlike HostLevelsService.awardRule). Called from
  // wherever a small, well-defined, already-happening event should count toward Rryda Identity —
  // see the call sites in missions.service.ts, users.service.ts, social.service.ts and
  // economy/gift.service.ts. Never throws: identity progress must not block the activity that
  // earned it.
  async addXp(userId: string, amount: number) {
    const safe = Math.floor(Number(amount));
    if (!Number.isFinite(safe) || safe <= 0) return;
    try {
      const levels = await this.prisma.rrydaLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
      const user = await this.prisma.user.update({ where: { id: userId }, data: { rrydaXp: { increment: safe } }, select: { rrydaXp: true, rrydaLevel: true } });
      const level = [...levels].reverse().find((l) => l.xpRequired <= user.rrydaXp)?.level ?? 1;
      if (level !== user.rrydaLevel) {
        await this.prisma.user.update({ where: { id: userId }, data: { rrydaLevel: level } });
      }
      if (user.rrydaLevel < level) {
        const reached = levels.find((l) => l.level === level);
        await this.notifications.notifyOnce(userId, 'RRYDA_LEVEL_UP', `rryda-level:${level}:${user.rrydaXp}`, {
          level, name: reached?.name ?? `Level ${level}`, xp: user.rrydaXp,
        });
      }
    } catch {
      /* identity XP is a bonus signal, never a reason to fail the action that earned it */
    }
  }
}
