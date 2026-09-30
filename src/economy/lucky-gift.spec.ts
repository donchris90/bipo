import { luckyGameType, validateLuckyRewards } from './lucky-gift';

describe('lucky gifts', () => {
  it('validates reward tiers', () => {
    expect(validateLuckyRewards([{ label: 'Try Again', coins: 0, weight: 35 }, { label: 'Jackpot', coins: 1000, weight: 1 }])).toHaveLength(2);
  });
  it('rejects invalid weights', () => {
    expect(() => validateLuckyRewards([{ label: 'x', coins: 1, weight: 0 }, { label: 'y', coins: 2, weight: 1 }])).toThrow();
  });
  it('normalizes supported game types', () => {
    expect(luckyGameType('Golden')).toBe('mystery');
    expect(luckyGameType('gold')).toBe('gold');
  });
});
