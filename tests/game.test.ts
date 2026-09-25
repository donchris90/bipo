import { computeMultipliers, computeBaseStakes, scaleStakes, suggestStakes, sumStakes, allNumbers } from '../src/game';
import { DEFAULT_CONFIG } from '../src/types';

describe('multipliers', () => {
  it('are all whole numbers', () => {
    const multipliers = computeMultipliers(DEFAULT_CONFIG);
    for (const m of multipliers) {
      expect(Number.isInteger(m)).toBe(true);
    }
  });

  it('never exceed the configured cap', () => {
    const config = { ...DEFAULT_CONFIG, multiplierCap: 50 };
    const multipliers = computeMultipliers(config);
    for (const m of multipliers) {
      expect(m).toBeLessThanOrEqual(50);
    }
  });

  it('are higher for rarer numbers (monotonic away from the center)', () => {
    const multipliers = computeMultipliers(DEFAULT_CONFIG);
    // 13 and 14 are the most common sums; 0 and 27 the rarest.
    expect(multipliers[0]).toBeGreaterThan(multipliers[6]);
    expect(multipliers[6]).toBeGreaterThan(multipliers[13]);
    expect(multipliers[27]).toBeGreaterThan(multipliers[21]);
    expect(multipliers[21]).toBeGreaterThan(multipliers[14]);
  });
});

describe('base stakes', () => {
  it('are all whole numbers, at least 1', () => {
    const stakes = computeBaseStakes(DEFAULT_CONFIG);
    for (const s of stakes) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
    }
  });

  it('are lower for likely numbers and higher for rare ones', () => {
    const stakes = computeBaseStakes(DEFAULT_CONFIG);
    expect(stakes[0]).toBeLessThan(stakes[13]);
    expect(stakes[27]).toBeLessThan(stakes[14]);
  });
});

describe('suggested total', () => {
  it('goes up as more numbers are picked and down as they are removed', () => {
    const small = suggestStakes([13, 14], DEFAULT_CONFIG).suggestedTotal;
    const medium = suggestStakes([11, 12, 13, 14, 15, 16], DEFAULT_CONFIG).suggestedTotal;
    const large = suggestStakes(allNumbers(), DEFAULT_CONFIG).suggestedTotal;
    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
  });
});

describe('stake scaling', () => {
  it('keeps every stake a whole number, minimum 1', () => {
    const { stakes } = suggestStakes([0, 5, 13, 20, 27], DEFAULT_CONFIG);
    const scaled = scaleStakes(stakes, 3); // aggressively small target
    for (const n of Object.keys(scaled).map(Number)) {
      expect(Number.isInteger(scaled[n])).toBe(true);
      expect(scaled[n]).toBeGreaterThanOrEqual(1);
    }
  });

  it('scales every stake by the same ratio (proportionally)', () => {
    const { stakes, suggestedTotal } = suggestStakes([5, 13, 22], DEFAULT_CONFIG);
    const target = suggestedTotal * 2;
    const scaled = scaleStakes(stakes, target);
    for (const n of Object.keys(stakes).map(Number)) {
      const expectedRatio = target / suggestedTotal;
      const actualRatio = scaled[n] / stakes[n];
      // Rounding means each ratio is only approximately equal, not exact.
      expect(actualRatio).toBeGreaterThan(expectedRatio * 0.5);
      expect(actualRatio).toBeLessThan(expectedRatio * 1.5);
    }
  });

  it('lands the scaled total reasonably close to the desired total', () => {
    const { stakes, suggestedTotal } = suggestStakes(allNumbers(), DEFAULT_CONFIG);
    const target = suggestedTotal * 3;
    const scaled = scaleStakes(stakes, target);
    const total = sumStakes(scaled);
    // Rounding 28 independent numbers can drift a little; should still be close.
    expect(Math.abs(total - target) / target).toBeLessThan(0.05);
  });
});
