export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAY_OFFSET_MINUTES = 60; // Africa/Lagos (WAT) is UTC+1 all year, no DST

export interface DayPeriod {
  key: string; // e.g. "2026-09-19"
  start: Date;
  end: Date;
}

// A calendar day in the platform's home timezone (a fixed UTC offset), NOT a
// rolling 24h window: anything that "resets daily" has to reset at a fixed,
// predictable moment. Shared by missions and the creator "valid days" count.
export function dayPeriod(now: Date, offsetMinutes = DEFAULT_DAY_OFFSET_MINUTES): DayPeriod {
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - offsetMinutes * 60_000);
  const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { key, start, end: new Date(start.getTime() + DAY_MS) };
}

// The calendar month (in the same fixed-offset timezone) containing `now`.
export function monthPeriod(now: Date, offsetMinutes = DEFAULT_DAY_OFFSET_MINUTES): DayPeriod {
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, '0')}`,
    start: new Date(Date.UTC(y, m, 1) - offsetMinutes * 60_000),
    end: new Date(Date.UTC(y, m + 1, 1) - offsetMinutes * 60_000),
  };
}

// Seconds of broadcast per local calendar day, for sessions clipped to
// [windowStart, windowEnd). A session that runs past midnight is split
// across the days it actually covers.
export function secondsPerDay(
  sessions: { start: Date; end: Date }[],
  windowStart: Date,
  windowEnd: Date,
  offsetMinutes = DEFAULT_DAY_OFFSET_MINUTES,
): Map<string, number> {
  const perDay = new Map<string, number>();
  for (const s of sessions) {
    let cursor = new Date(Math.max(s.start.getTime(), windowStart.getTime()));
    const stop = Math.min(s.end.getTime(), windowEnd.getTime());
    while (cursor.getTime() < stop) {
      const day = dayPeriod(cursor, offsetMinutes);
      const segmentEnd = Math.min(stop, day.end.getTime());
      perDay.set(day.key, (perDay.get(day.key) ?? 0) + Math.round((segmentEnd - cursor.getTime()) / 1000));
      cursor = new Date(segmentEnd);
    }
  }
  return perDay;
}
