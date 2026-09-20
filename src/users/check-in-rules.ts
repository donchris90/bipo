// Pure check-in rules, kept apart from UsersService (no Prisma / Nest imports)
// so the streak arithmetic is directly testable.
//
// A "day" is a UTC calendar day, not a rolling 24h window: check in any time
// Tuesday, eligible again any time Wednesday.

const DAY_MS = 24 * 60 * 60 * 1000;

// Daily check-in reward — a real, disclosed formula, not a hidden number:
// 10 coins per streak day, capped at a 7-day streak (70 coins max) so the
// reward doesn't grow unbounded for a very long streak.
export const CHECK_IN_COINS_PER_DAY = 10;
export const CHECK_IN_MAX_STREAK_DAYS = 7;

export function computeCheckInReward(streak: number): bigint {
  return BigInt(CHECK_IN_COINS_PER_DAY * Math.min(streak, CHECK_IN_MAX_STREAK_DAYS));
}

// Coins for streak days 1..7, so clients can draw the calendar from the
// server's numbers instead of duplicating the formula.
export const CHECK_IN_REWARD_SCHEDULE: number[] = Array.from({ length: CHECK_IN_MAX_STREAK_DAYS }, (_, i) =>
  Number(computeCheckInReward(i + 1)),
);

export function toUtcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
}

export interface CheckInState {
  checkedInToday: boolean;
  // The streak as it stands right now. The stored counter is only reset when
  // the user next checks in, so after a missed day it is stale — this is 0
  // in that case.
  streak: number;
  // The streak length a check-in today produces (or already produced).
  nextStreak: number;
}

export function resolveCheckIn(lastCheckInAt: Date | null, storedStreak: number, now: Date): CheckInState {
  const today = toUtcDateKey(now);
  const yesterday = toUtcDateKey(new Date(now.getTime() - DAY_MS));
  const last = lastCheckInAt ? toUtcDateKey(lastCheckInAt) : null;

  const checkedInToday = last === today;
  const alive = checkedInToday || last === yesterday;
  const streak = alive ? storedStreak : 0;
  return { checkedInToday, streak, nextStreak: checkedInToday ? streak : streak + 1 };
}
