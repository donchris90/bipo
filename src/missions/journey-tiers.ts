// Pure Rryda Journey rules, kept apart from MissionsService (no Prisma / Nest imports) so the
// tier and streak arithmetic is directly testable — same pattern as users/check-in-rules.ts.

const DAY_MS = 24 * 60 * 60 * 1000;

export type JourneyTierKey = 'HALFWAY' | 'ALL';

export interface JourneyTier {
  key: JourneyTierKey;
  // How many of today's EVERYONE-audience missions must be complete to reach this tier.
  threshold: number;
  rewardCoins: number;
}

/**
 * The chest tiers for a day with `totalMissions` EVERYONE-audience missions configured.
 * Thresholds scale with the count rather than being hardcoded at 3 and 5, so an admin can add or
 * remove Journey missions later without this silently becoming wrong. With the product brief's
 * default of 5 missions this works out to exactly "3 -> Daily Chest, 5 -> Perfect Day": halfway
 * (rounded up) and all of them.
 */
export function journeyTiers(totalMissions: number, halfwayReward: number, allReward: number): JourneyTier[] {
  if (totalMissions <= 0) return [];
  const halfway = Math.max(1, Math.ceil(totalMissions / 2));
  // Too few missions configured for two distinct thresholds (e.g. only 1 or 2 total): collapse to
  // a single "complete them all" chest rather than showing two tiers with the same requirement.
  if (halfway >= totalMissions) return [{ key: 'ALL', threshold: totalMissions, rewardCoins: allReward }];
  return [
    { key: 'HALFWAY', threshold: halfway, rewardCoins: halfwayReward },
    { key: 'ALL', threshold: totalMissions, rewardCoins: allReward },
  ];
}

function toUtcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface PerfectDayState {
  // True if the ALL tier for TODAY has already been claimed (claiming it again should be refused
  // by the unique constraint anyway, but the caller can check this first to skip the attempt).
  alreadyToday: boolean;
  // The streak value to STORE after today's Perfect Day is claimed.
  nextStreak: number;
}

/**
 * Same "yesterday keeps it alive, anything older resets it" rule as resolveCheckIn(), applied to
 * the day the Journey's ALL tier was last claimed. Call this only once the caller has confirmed
 * today's ALL tier is actually reached — this function doesn't check that itself.
 */
export function resolvePerfectDayStreak(lastPerfectDayAt: Date | null, storedStreak: number, now: Date): PerfectDayState {
  const today = toUtcDateKey(now);
  const yesterday = toUtcDateKey(new Date(now.getTime() - DAY_MS));
  const last = lastPerfectDayAt ? toUtcDateKey(lastPerfectDayAt) : null;

  const alreadyToday = last === today;
  const alive = alreadyToday || last === yesterday;
  const streak = alive ? storedStreak : 0;
  return { alreadyToday, nextStreak: alreadyToday ? streak : streak + 1 };
}
