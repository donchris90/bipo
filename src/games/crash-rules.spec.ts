import {
  generateCrashPoint,
  currentMultiplier,
  crashTimeSeconds,
  resolveCashout,
  resolveAutoCashout,
  computeCrashReward,
  randomIntToUnitInterval,
} from './crash-rules';

const HOUSE_EDGE = 0.03;
const GROWTH_RATE = Math.log(2) / 5; // reaches 2.00x at 5 seconds

describe('generateCrashPoint', () => {
  it('never produces a crash point below 1.00', () => {
    for (let i = 0; i < 5000; i++) {
      const randomInt = Math.floor(Math.random() * 2 ** 32);
      expect(generateCrashPoint(randomInt, HOUSE_EDGE)).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('is deterministic for the same random input', () => {
    const a = generateCrashPoint(123456789, HOUSE_EDGE);
    const b = generateCrashPoint(123456789, HOUSE_EDGE);
    expect(a).toBe(b);
  });

  it('produces higher crash points as the random input increases (monotonic)', () => {
    const low = generateCrashPoint(1000, HOUSE_EDGE);
    const mid = generateCrashPoint(2 ** 31, HOUSE_EDGE);
    const high = generateCrashPoint(2 ** 32 - 1000, HOUSE_EDGE);
    expect(low).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(high);
  });

  it('holds the house edge statistically: average return from "always cash out at a fixed multiplier m" converges near (1 - houseEdge)', () => {
    // This is the actual defining property of the formula — verified
    // empirically here rather than just trusted algebraically, since a
    // sign error or off-by-one would silently produce a broken house edge
    // that's very easy to miss by eyeballing individual crash points.
    const trials = 200_000;
    const m = 2.0; // fixed cash-out target
    let totalReturn = 0;
    for (let i = 0; i < trials; i++) {
      const randomInt = Math.floor(Math.random() * 2 ** 32);
      const crashPoint = generateCrashPoint(randomInt, HOUSE_EDGE);
      totalReturn += crashPoint >= m ? m : 0; // win m, or lose the 1 unit staked (0 return)
    }
    const averageReturn = totalReturn / trials;
    const expected = 1 - HOUSE_EDGE;
    // Generous tolerance — this is a statistical check on a random
    // simulation, not an exact arithmetic one.
    expect(averageReturn).toBeGreaterThan(expected - 0.03);
    expect(averageReturn).toBeLessThan(expected + 0.03);
  });
});

describe('currentMultiplier', () => {
  it('is exactly 1.00 at t=0 and before', () => {
    expect(currentMultiplier(0, GROWTH_RATE)).toBe(1.0);
    expect(currentMultiplier(-5, GROWTH_RATE)).toBe(1.0);
  });

  it('reaches ~2.00x at the configured 5-second mark', () => {
    expect(currentMultiplier(5, GROWTH_RATE)).toBeCloseTo(2.0, 1);
  });

  it('is strictly increasing over time', () => {
    let prev = currentMultiplier(0, GROWTH_RATE);
    for (let t = 1; t <= 20; t++) {
      const next = currentMultiplier(t, GROWTH_RATE);
      expect(next).toBeGreaterThan(prev);
      prev = next;
    }
  });
});

describe('crashTimeSeconds / currentMultiplier round-trip', () => {
  it('currentMultiplier at the computed crash time equals the crash point (within flooring tolerance)', () => {
    for (const crashPoint of [1.01, 1.5, 2.0, 5.0, 10.0, 50.0]) {
      const t = crashTimeSeconds(crashPoint, GROWTH_RATE);
      expect(currentMultiplier(t, GROWTH_RATE)).toBeCloseTo(crashPoint, 1);
    }
  });
});

describe('resolveCashout', () => {
  it('succeeds when cashing out well before the crash', () => {
    const crashPoint = 5.0;
    const crashAt = crashTimeSeconds(crashPoint, GROWTH_RATE);
    const result = resolveCashout(crashAt / 2, crashPoint, GROWTH_RATE);
    expect(result.success).toBe(true);
    expect(result.multiplier).toBeLessThan(crashPoint);
    expect(result.multiplier).toBeGreaterThanOrEqual(1.0);
  });

  it('fails when the round has already crashed by the requested time', () => {
    const crashPoint = 2.0;
    const crashAt = crashTimeSeconds(crashPoint, GROWTH_RATE);
    const result = resolveCashout(crashAt + 1, crashPoint, GROWTH_RATE);
    expect(result.success).toBe(false);
    expect(result.multiplier).toBeUndefined();
  });

  it('fails exactly at the crash instant (not a valid cash-out)', () => {
    const crashPoint = 3.0;
    const crashAt = crashTimeSeconds(crashPoint, GROWTH_RATE);
    const result = resolveCashout(crashAt, crashPoint, GROWTH_RATE);
    expect(result.success).toBe(false);
  });

  it('never returns a multiplier greater than or equal to the crash point', () => {
    const crashPoint = 4.0;
    const crashAt = crashTimeSeconds(crashPoint, GROWTH_RATE);
    for (const fraction of [0.9, 0.95, 0.99, 0.999]) {
      const result = resolveCashout(crashAt * fraction, crashPoint, GROWTH_RATE);
      if (result.success) {
        expect(result.multiplier!).toBeLessThan(crashPoint);
      }
    }
  });
});

describe('resolveAutoCashout', () => {
  it('wins when the target is below the crash point', () => {
    const result = resolveAutoCashout(2.0, 3.0);
    expect(result.won).toBe(true);
    expect(result.multiplier).toBe(2.0);
  });

  it('loses when the target equals the crash point exactly', () => {
    const result = resolveAutoCashout(3.0, 3.0);
    expect(result.won).toBe(false);
  });

  it('loses when the target is above the crash point', () => {
    const result = resolveAutoCashout(5.0, 3.0);
    expect(result.won).toBe(false);
  });
});

describe('computeCrashReward', () => {
  it('multiplies stake by the cash-out multiplier, floored', () => {
    expect(computeCrashReward(100, 2.0)).toBe(200);
    expect(computeCrashReward(100, 2.5)).toBe(250);
  });

  it('floors a fractional result rather than rounding up', () => {
    expect(computeCrashReward(100, 2.999)).toBe(299); // not 300
  });

  it('never produces a negative reward for any positive stake and multiplier >= 1', () => {
    for (let stake = 1; stake <= 1000; stake += 97) {
      for (const m of [1.0, 1.5, 2.0, 10.0, 100.0]) {
        expect(computeCrashReward(stake, m)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('randomIntToUnitInterval', () => {
  it('stays strictly within (0, 1) for the valid input range', () => {
    expect(randomIntToUnitInterval(1)).toBeGreaterThan(0);
    expect(randomIntToUnitInterval(2 ** 32 - 1)).toBeLessThan(1);
  });
});
