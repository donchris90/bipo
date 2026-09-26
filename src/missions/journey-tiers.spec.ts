import { journeyTiers, resolvePerfectDayStreak } from './journey-tiers';

describe('journeyTiers', () => {
  it('matches the product brief exactly for 5 missions: 3 -> chest, 5 -> perfect day', () => {
    const tiers = journeyTiers(5, 50, 150);
    expect(tiers).toEqual([
      { key: 'HALFWAY', threshold: 3, rewardCoins: 50 },
      { key: 'ALL', threshold: 5, rewardCoins: 150 },
    ]);
  });

  it('scales the halfway threshold if the admin adds or removes missions', () => {
    expect(journeyTiers(8, 50, 150).map((t) => t.threshold)).toEqual([4, 8]);
    expect(journeyTiers(3, 50, 150).map((t) => t.threshold)).toEqual([2, 3]);
  });

  it('collapses to a single ALL chest only when halfway and all would be the same requirement', () => {
    expect(journeyTiers(1, 50, 150)).toEqual([{ key: 'ALL', threshold: 1, rewardCoins: 150 }]);
  });

  it('still gives two distinct tiers for exactly 2 missions (1 of 2, then 2 of 2)', () => {
    expect(journeyTiers(2, 50, 150)).toEqual([
      { key: 'HALFWAY', threshold: 1, rewardCoins: 50 },
      { key: 'ALL', threshold: 2, rewardCoins: 150 },
    ]);
  });

  it('returns nothing when there are no Journey missions configured at all', () => {
    expect(journeyTiers(0, 50, 150)).toEqual([]);
  });
});

describe('resolvePerfectDayStreak', () => {
  it('starts a streak of 1 on the first Perfect Day', () => {
    const s = resolvePerfectDayStreak(null, 0, new Date('2026-09-19T12:00:00Z'));
    expect(s).toEqual({ alreadyToday: false, nextStreak: 1 });
  });

  it('extends the streak when the last Perfect Day was yesterday', () => {
    const s = resolvePerfectDayStreak(new Date('2026-09-18T09:00:00Z'), 6, new Date('2026-09-19T12:00:00Z'));
    expect(s).toEqual({ alreadyToday: false, nextStreak: 7 });
  });

  it('resets after a missed day', () => {
    const s = resolvePerfectDayStreak(new Date('2026-09-15T09:00:00Z'), 6, new Date('2026-09-19T12:00:00Z'));
    expect(s).toEqual({ alreadyToday: false, nextStreak: 1 });
  });

  it('reports alreadyToday without changing the streak if called again the same day', () => {
    const s = resolvePerfectDayStreak(new Date('2026-09-19T08:00:00Z'), 4, new Date('2026-09-19T20:00:00Z'));
    expect(s).toEqual({ alreadyToday: true, nextStreak: 4 });
  });
});
