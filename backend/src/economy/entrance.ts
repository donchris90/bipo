import { PrismaService } from '../prisma/prisma.service';
import { tierFor } from './gifter.service';
import { topBadgeFor } from '../badges/badge-lookup';

// How grand someone's arrival is, 0 (nothing) to 4. The app plays a different animation for each:
//   1 WELCOME  a slim glass chip                 — a fan club member / early supporter walks in
//   2 VIP      a gold banner with a shine sweep  — VIP 1-2 gifters
//   3 ROYAL    a cinematic band with a crown     — VIP 3 gifters, and this creator's biggest supporters
//   4 LEGEND   a full-screen moment              — VIP 4 (1M+ lifetime coins), or a Mythic supporter of THIS creator
export type EntrancePresentation = 0 | 1 | 2 | 3 | 4;
export const PRESENTATION_NAMES = ['NONE', 'WELCOME', 'VIP', 'ROYAL', 'LEGEND'] as const;

export interface EntranceInput {
  // Global gifter level from GifterService's TIERS (0 = New Gifter ... 5 = VIP 4).
  gifterLevel: number;
  // Level in THIS creator's supporter curve (SupporterLevel: 1 = New Supporter ... 10 = Mythic).
  supporterLevel: number;
  fanClubMember: boolean;
}

// Two independent things earn a bigger entrance: how much you have gifted anywhere on Rryda, and
// how much you have supported the creator whose room you are walking into. Someone who is a
// Diamond supporter of THIS host is a somebody HERE even if they have gifted little elsewhere —
// that is what makes an entrance feel earned rather than a spending leaderboard. The numbers are
// judgement calls in one place so they can be tuned.
export function presentationTier({ gifterLevel, supporterLevel, fanClubMember }: EntranceInput): EntrancePresentation {
  let tier = gifterLevel >= 5 ? 4 : gifterLevel >= 4 ? 3 : gifterLevel >= 2 ? 2 : 0;
  if (supporterLevel >= 9) tier = Math.max(tier, 3); // Legendary / Mythic for this creator
  else if (supporterLevel >= 7) tier = Math.max(tier, 2); // Diamond / Elite
  else if (supporterLevel >= 4) tier = Math.max(tier, 1); // Silver and up
  if (fanClubMember) tier = Math.max(tier, 1);
  // A Mythic (level 10) supporter of this creator arriving in their own community is the top moment.
  if (supporterLevel >= 10) tier = 4;
  return Math.min(4, tier) as EntrancePresentation;
}

export interface EntrancePayload {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  // Kept for older app builds, which show these two: the gifter tier name and level.
  tier: string;
  level: number;
  message: string;
  // What newer builds use to pick the animation.
  presentation: EntrancePresentation;
  presentationName: (typeof PRESENTATION_NAMES)[number];
  rrydaLevel: number;
  supporterLevel: number;
  fanClub: boolean;
  badgeEmoji: string | null;
}

// Everything needed to show one arrival, or null when this person gets no entrance (or is the host).
// Plain function taking PrismaService — not an injectable — so LiveService and RoomsService can
// both use it without a new module dependency.
export async function resolveEntrance(
  prisma: PrismaService,
  userId: string,
  hostId: string,
  place: 'live' | 'room',
): Promise<EntrancePayload | null> {
  if (userId === hostId) return null;

  const [aggregate, user, bond, badge] = await Promise.all([
    prisma.giftTransaction.aggregate({ where: { senderId: userId }, _sum: { coinAmount: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, avatarUrl: true, rrydaLevel: true } }),
    prisma.creatorSupporter.findUnique({
      where: { supporterId_creatorId: { supporterId: userId, creatorId: hostId } },
      select: { level: true, fanClubJoinedAt: true },
    }),
    topBadgeFor(prisma, userId).catch(() => null),
  ]);
  if (!user) return null;

  const gifter = tierFor(aggregate._sum.coinAmount ?? 0);
  const supporterLevel = bond?.level ?? 0;
  const fanClub = !!bond?.fanClubJoinedAt;
  const presentation = presentationTier({ gifterLevel: gifter.level, supporterLevel, fanClubMember: fanClub });
  if (presentation === 0) return null;

  const name = user.displayName ?? 'A VIP';
  return {
    userId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    tier: gifter.level >= 2 ? gifter.name : fanClub ? 'Fan Club' : 'Supporter',
    level: gifter.level,
    message: `${name} entered the ${place === 'live' ? 'live' : 'room'}`,
    presentation,
    presentationName: PRESENTATION_NAMES[presentation],
    rrydaLevel: user.rrydaLevel,
    supporterLevel,
    fanClub,
    badgeEmoji: badge?.emoji ?? null,
  };
}
