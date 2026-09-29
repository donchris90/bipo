import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

// Thresholds for the five badges (see the migration's seed catalog for their labels). Kept here
// rather than in the Badge row itself, same trade-off as the Journey chest rewards and the Rryda
// Level curve elsewhere in this codebase: a concrete number now, rather than an admin config
// screen nobody asked for yet.
const TOP_SUPPORTER_COINS = 5000;
const PK_CHAMPION_WINS = 10;
const EARLY_RRYDA_RANK = 1000;

export interface BadgeStatus {
  key: string;
  label: string;
  emoji: string;
  description: string;
  earned: boolean;
  earnedAt: string | null;
}

@Injectable()
export class BadgesService {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  async myBadges(userId: string): Promise<BadgeStatus[]> {
    const [catalog, earned] = await Promise.all([
      this.prisma.badge.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.userBadge.findMany({ where: { userId } }),
    ]);
    const earnedByKey = new Map(earned.map((e) => [e.badgeKey, e]));
    return catalog.map((b) => {
      const e = earnedByKey.get(b.key);
      return { key: b.key, label: b.label, emoji: b.emoji, description: b.description, earned: !!e, earnedAt: e?.earnedAt.toISOString() ?? null };
    });
  }

  // Checks every badge condition against real, current data and awards whichever are newly met.
  // A badge already earned is never re-checked or revoked, even if the underlying stat later
  // drops (a streak badge survives a broken streak — that's the point of a badge over a live
  // stat). Cheap to call opportunistically (see MissionsService.list(), already polled by the
  // app) rather than needing a dedicated hook in every place a stat could change. Never throws:
  // badge evaluation is a bonus signal, not a reason to fail whatever triggered it.
  async evaluateAndAward(userId: string): Promise<BadgeStatus[]> {
    try {
      const already = await this.prisma.userBadge.findMany({ where: { userId }, select: { badgeKey: true } });
      const have = new Set(already.map((b) => b.badgeKey));
      const missing = ['STREAK_7', 'PERFECT_WEEK', 'TOP_SUPPORTER', 'PK_CHAMPION', 'EARLY_RRYDA'].filter((k) => !have.has(k));
      if (missing.length === 0) return [];

      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { checkInStreak: true, perfectDayStreak: true, createdAt: true } });
      if (!user) return [];

      const toAward: string[] = [];
      if (missing.includes('STREAK_7') && user.checkInStreak >= 7) toAward.push('STREAK_7');
      if (missing.includes('PERFECT_WEEK') && user.perfectDayStreak >= 7) toAward.push('PERFECT_WEEK');

      if (missing.includes('TOP_SUPPORTER')) {
        const sent = await this.prisma.giftTransaction.aggregate({ where: { senderId: userId }, _sum: { coinAmount: true } });
        if ((sent._sum.coinAmount ?? 0) >= TOP_SUPPORTER_COINS) toAward.push('TOP_SUPPORTER');
      }

      if (missing.includes('PK_CHAMPION')) {
        const wins = await this.prisma.pKBattle.count({ where: { status: 'SETTLED', winnerId: userId } });
        if (wins >= PK_CHAMPION_WINS) toAward.push('PK_CHAMPION');
      }

      if (missing.includes('EARLY_RRYDA')) {
        // A stable historical fact once computed: how many accounts existed before this one, by
        // creation order, never changes for THIS user no matter how many more sign up later.
        const earlier = await this.prisma.user.count({ where: { createdAt: { lt: user.createdAt } } });
        if (earlier < EARLY_RRYDA_RANK) toAward.push('EARLY_RRYDA');
      }

      if (toAward.length === 0) return [];

      const newly: BadgeStatus[] = [];
      for (const key of toAward) {
        try {
          await this.prisma.userBadge.create({ data: { userId, badgeKey: key } });
        } catch {
          continue; // already awarded concurrently — not a new badge from this call
        }
        const badge = await this.prisma.badge.findUnique({ where: { key } });
        if (!badge) continue;
        await this.notifications.notifyOnce(userId, 'BADGE_EARNED', `badge:${key}`, { key, label: badge.label, emoji: badge.emoji });
        newly.push({ key, label: badge.label, emoji: badge.emoji, description: badge.description, earned: true, earnedAt: new Date().toISOString() });
      }
      return newly;
    } catch {
      return [];
    }
  }
}
