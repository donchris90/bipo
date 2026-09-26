import { PrismaService } from '../prisma/prisma.service';

// Read-only "which single badge should show beside this name" lookup — deliberately NOT part of
// BadgesService. BadgesService depends on NotificationsService (to announce a new badge), and
// NotificationsModule depends on RealtimeModule (to push over the socket) — so if RealtimeGateway
// imported BadgesService directly, the module graph would cycle:
//   RealtimeModule -> BadgesModule -> NotificationsModule -> RealtimeModule
// This file has no NestJS dependency injection at all (same style as ../common/public-name.ts and
// ../common/chat-history.ts already used for the same reason), so realtime.gateway.ts and
// chat-history.ts can use it directly.
//
// Rarest/hardest-to-get first: when someone has earned more than one badge, only the single most
// prestigious one shows beside their name in chat — showing all of them would be clutter. This
// order is a product judgement call, kept here as the one place it's made.
const BADGE_PRIORITY = ['EARLY_RRYDA', 'PK_CHAMPION', 'TOP_SUPPORTER', 'PERFECT_WEEK', 'STREAK_7'];

export interface BadgeSummary {
  key: string;
  emoji: string;
  label: string;
}

/** Batched: the single best badge for each of `userIds`, for everyone who has earned at least one. */
export async function topBadgesFor(prisma: PrismaService, userIds: string[]): Promise<Map<string, BadgeSummary>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, BadgeSummary>();
  if (ids.length === 0) return out;

  const rows = await prisma.userBadge.findMany({
    where: { userId: { in: ids } },
    include: { badge: true },
  });

  const byUser = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }

  for (const [userId, earned] of byUser) {
    const best = earned
      .filter((e) => e.badge.active)
      .sort((a, b) => BADGE_PRIORITY.indexOf(a.badgeKey) - BADGE_PRIORITY.indexOf(b.badgeKey))[0];
    if (best) out.set(userId, { key: best.badgeKey, emoji: best.badge.emoji, label: best.badge.label });
  }
  return out;
}

export async function topBadgeFor(prisma: PrismaService, userId: string): Promise<BadgeSummary | null> {
  const map = await topBadgesFor(prisma, [userId]);
  return map.get(userId) ?? null;
}
