import {
  CHECK_IN_REWARD_SCHEDULE,
  computeCheckInReward,
  resolveCheckIn,
} from './check-in-rules';

const at = (iso: string) => new Date(iso);

describe('computeCheckInReward', () => {
  it('pays 10 coins per streak day, capped at 7 days', () => {
    expect(computeCheckInReward(1)).toBe(10n);
    expect(computeCheckInReward(7)).toBe(70n);
    expect(computeCheckInReward(8)).toBe(70n);
    expect(computeCheckInReward(400)).toBe(70n);
  });

  it('publishes the schedule clients draw the calendar from', () => {
    expect(CHECK_IN_REWARD_SCHEDULE).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });
});

describe('resolveCheckIn', () => {
  const now = at('2026-09-19T12:00:00Z');

  it('a user who never checked in has no streak; a check-in makes day 1', () => {
    expect(resolveCheckIn(null, 0, now)).toEqual({ checkedInToday: false, streak: 0, nextStreak: 1 });
  });

  it('already checked in today: streak is kept and nothing further is due', () => {
    expect(resolveCheckIn(at('2026-09-19T00:01:00Z'), 4, now)).toEqual({ checkedInToday: true, streak: 4, nextStreak: 4 });
  });

  it('checked in yesterday: the streak is alive and today would extend it', () => {
    expect(resolveCheckIn(at('2026-09-18T23:59:00Z'), 4, now)).toEqual({ checkedInToday: false, streak: 4, nextStreak: 5 });
  });

  it('missed a day: the stale stored streak reads as 0, so the next reward is day 1', () => {
    const state = resolveCheckIn(at('2026-09-17T12:00:00Z'), 6, now);
    expect(state).toEqual({ checkedInToday: false, streak: 0, nextStreak: 1 });
    expect(computeCheckInReward(state.nextStreak)).toBe(10n); // not the 70 the stale streak would suggest
  });

  it('uses UTC calendar days, not a rolling 24h window', () => {
    // 23:00 -> 01:00 next day is 2 hours apart but two different UTC days.
    expect(resolveCheckIn(at('2026-09-18T23:00:00Z'), 2, at('2026-09-19T01:00:00Z'))).toEqual({
      checkedInToday: false,
      streak: 2,
      nextStreak: 3,
    });
    // 00:01 -> 23:59 the same day is ~24h apart but still the same UTC day.
    expect(resolveCheckIn(at('2026-09-19T00:01:00Z'), 2, at('2026-09-19T23:59:00Z')).checkedInToday).toBe(true);
  });
});
