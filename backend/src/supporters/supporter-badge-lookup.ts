import { PrismaService } from '../prisma/prisma.service';

// Read-only "what supporter tier is this person, to THIS creator" lookup — same reasoning as
// ../badges/badge-lookup.ts: SupporterLevelsService depends on NotificationsService, which
// depends on RealtimeModule, so if RealtimeGateway imported SupporterLevelsService directly the
// module graph would cycle the same way. This file has no NestJS dependency injection at all, so
// realtime.gateway.ts and chat-history.ts can use it directly.
//
// Unlike badge-lookup.ts (one badge per user, platform-wide), a supporter tier only means
// something relative to a creator — "Gold Supporter" beside a name in Amara's Live only makes
// sense because it's Amara's Live. Callers must already know which creator the context belongs
// to (the live session's hostId, the party room's ownerId, etc.) — this helper doesn't resolve
// that itself, since LIVE and PARTY resolve "whose room is this" differently.

export interface SupporterBadgeSummary {
  level: number;
  name: string;
  badgeUrl: string | null;
}

/** Batched: each of `supporterIds`' current tier toward `creatorId`, for whoever has supported them at least once. */
export async function topSupporterBadgesFor(
  prisma: PrismaService,
  creatorId: string,
  supporterIds: string[],
): Promise<Map<string, SupporterBadgeSummary>> {
  const ids = [...new Set(supporterIds)];
  const out = new Map<string, SupporterBadgeSummary>();
  if (ids.length === 0) return out;

  const [rows, levels] = await Promise.all([
    prisma.creatorSupporter.findMany({ where: { creatorId, supporterId: { in: ids } } }),
    prisma.supporterLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
  ]);
  const levelByNumber = new Map(levels.map((l) => [l.level, l]));

  for (const row of rows) {
    // Level 1 ("New Supporter") is the default everyone starts at — not worth showing beside a
    // name, same product judgement as badge-lookup.ts skipping people with zero badges.
    if (row.level <= 1) continue;
    const def = levelByNumber.get(row.level);
    if (!def) continue;
    out.set(row.supporterId, { level: def.level, name: def.name, badgeUrl: def.badgeUrl });
  }
  return out;
}

export async function topSupporterBadgeFor(
  prisma: PrismaService,
  creatorId: string,
  supporterId: string,
): Promise<SupporterBadgeSummary | null> {
  const map = await topSupporterBadgesFor(prisma, creatorId, [supporterId]);
  return map.get(supporterId) ?? null;
}
