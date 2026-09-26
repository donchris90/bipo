import { BadRequestException, Injectable } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';

// Supporter Level: progression scoped to ONE (supporter, creator) pair, distinct from both
// RrydaLevelsService (platform-wide identity, any activity counts) and HostLevelsService
// (creator-only, gates broadcasting features). This one gates nothing — it exists so a fan's
// cumulative support for a specific creator adds up to a visible, persistent rank, instead of
// only ever showing up as a per-session "top gifter" (see live.service.ts's topGifters groupBy,
// which resets every stream).
//
// Architecture deliberately mirrors RrydaLevelsService/HostLevelsService: a small
// admin-configurable level table (SupporterLevel) plus addXp() incrementing xp and recomputing
// the level, notifying once on level-up. The one structural difference is the XP row itself
// lives on CreatorSupporter (keyed on the pair), not on User (keyed on one id) — a person can be
// a Gold Supporter of one creator and a New Supporter of another at the same time.
@Injectable()
export class SupporterLevelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.prisma.supporterLevel.findMany({ orderBy: { level: 'asc' } });
  }

  private static readonly FALLBACK = { level: 1, name: 'New Supporter', xpRequired: 0, badgeUrl: null as string | null };

  private shapeProgress(xp: number, levels: { level: number; name: string; xpRequired: number; badgeUrl: string | null }[]) {
    const reached = levels.filter((l) => l.xpRequired <= xp);
    const current = reached[reached.length - 1] ?? levels[0] ?? SupporterLevelsService.FALLBACK;
    const next = levels.find((l) => l.xpRequired > xp) ?? null;
    return {
      xp,
      level: current.level,
      name: current.name,
      badgeUrl: current.badgeUrl,
      nextLevel: next ? { level: next.level, name: next.name, xpRequired: next.xpRequired } : null,
      progressXp: next ? Math.max(0, xp - current.xpRequired) : 0,
      requiredForNext: next ? Math.max(0, next.xpRequired - current.xpRequired) : 0,
      remainingXp: next ? Math.max(0, next.xpRequired - xp) : 0,
    };
  }

  // A supporter's progress toward ONE creator. Returns the zero-state (level 1, no gifts yet)
  // rather than 404ing when the pair has never sent a gift — most viewers of a creator's profile
  // have never supported them yet, and that's a normal, displayable state, not an error.
  async progress(supporterId: string, creatorId: string) {
    const [row, levels] = await Promise.all([
      this.prisma.creatorSupporter.findUnique({ where: { supporterId_creatorId: { supporterId, creatorId } } }),
      this.prisma.supporterLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
    ]);
    const shaped = this.shapeProgress(row?.xp ?? 0, levels);
    return {
      ...shaped,
      creatorId,
      totalGiftCoins: row?.totalGiftCoins ?? 0,
      giftCount: row?.giftCount ?? 0,
      firstGiftAt: row?.firstGiftAt?.toISOString() ?? null,
      lastGiftAt: row?.lastGiftAt?.toISOString() ?? null,
    };
  }

  // Lifetime top supporters of ONE creator — the persistent counterpart to live.service.ts's
  // per-session topGifters. Shown on a creator's profile / Live / Party, not reset by any single
  // broadcast ending.
  async topSupporters(creatorId: string, limit = 10) {
    const safeLimit = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 10));
    const rows = await this.prisma.creatorSupporter.findMany({
      where: { creatorId },
      orderBy: { xp: 'desc' },
      take: safeLimit,
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.supporterId) } },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const levels = await this.prisma.supporterLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
    return rows.map((r, index) => ({
      rank: index + 1,
      supporterId: r.supporterId,
      displayName: byId.get(r.supporterId)?.displayName ?? null,
      avatarUrl: byId.get(r.supporterId)?.avatarUrl ?? null,
      xp: r.xp,
      totalGiftCoins: r.totalGiftCoins,
      ...this.shapeProgress(r.xp, levels),
    }));
  }

  // Called from gift.service.ts's send() at the same call site that already calls
  // rrydaLevels.addXp() and hostLevels.awardRule() — one more progression signal fed off the
  // same already-happening event, not a new hook. amount is the raw coin amount of the gift
  // (see the migration note: this XP is denominated directly in coins, no conversion). Never
  // throws: supporter progression is a bonus signal, never a reason to fail a paid gift.
  async addXp(supporterId: string, creatorId: string, amount: number) {
    const safe = Math.floor(Number(amount));
    if (!Number.isFinite(safe) || safe <= 0) return;
    try {
      const levels = await this.prisma.supporterLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
      const row = await this.prisma.creatorSupporter.upsert({
        where: { supporterId_creatorId: { supporterId, creatorId } },
        update: { xp: { increment: safe }, totalGiftCoins: { increment: safe }, giftCount: { increment: 1 }, lastGiftAt: new Date() },
        create: { supporterId, creatorId, xp: safe, totalGiftCoins: safe, giftCount: 1 },
      });
      const level = [...levels].reverse().find((l) => l.xpRequired <= row.xp)?.level ?? 1;
      if (level !== row.level) {
        await this.prisma.creatorSupporter.update({ where: { id: row.id }, data: { level } });
      }
      if (row.level < level) {
        const reached = levels.find((l) => l.level === level);
        await this.notifications.notifyOnce(supporterId, 'SUPPORTER_LEVEL_UP', `supporter-level:${creatorId}:${level}:${row.xp}`, {
          creatorId, level, name: reached?.name ?? `Level ${level}`, xp: row.xp,
        });
      }
    } catch {
      /* supporter progression is a bonus signal, never a reason to fail the gift that earned it */
    }
  }

  async updateLevel(level: number, body: any, actorId: string, roles: RoleName[]) {
    if (!Number.isInteger(level) || level < 1 || level > 100) throw new BadRequestException('Level must be between 1 and 100');
    const xpRequired = Math.floor(Number(body.xpRequired));
    if (!Number.isFinite(xpRequired) || xpRequired < 0) throw new BadRequestException('xpRequired must be a non-negative number');
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 60) throw new BadRequestException('Level name is required and must be 60 characters or less');
    const updated = await this.prisma.supporterLevel.upsert({
      where: { level },
      update: { name, xpRequired, badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
      create: { level, name, xpRequired, badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'supporter_level.update', targetType: 'supporter_level', targetId: String(level), metadata: { xpRequired, name } });
    return updated;
  }
}
