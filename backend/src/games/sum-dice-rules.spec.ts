import {
  maxSum,
  rollDice,
  validateSelection,
  isWinningNumber,
  computeSumDiceReward,
  classifyResult,
  computePerNumberPool,
  DiceConfig,
} from './sum-dice-rules';

const CONFIG: DiceConfig = { diceCount: 3, diceSides: 10 };

describe('maxSum', () => {
  it('is diceCount * (diceSides - 1) — 3 dice of 0-9 sums to at most 27', () => {
    expect(maxSum(CONFIG)).toBe(27);
  });
});

describe('rollDice', () => {
  it('sums exactly the values the roll function produces', () => {
    const sequence = [3, 7, 2];
    let i = 0;
    const result = rollDice(CONFIG, () => sequence[i++]);
    expect(result.dice).toEqual([3, 7, 2]);
    expect(result.sum).toBe(12);
  });

  it('never exceeds maxSum or goes below 0 across many real rolls', () => {
    const roll = () => Math.floor(Math.random() * CONFIG.diceSides);
    for (let i = 0; i < 1000; i++) {
      const { sum } = rollDice(CONFIG, roll);
      expect(sum).toBeGreaterThanOrEqual(0);
      expect(sum).toBeLessThanOrEqual(maxSum(CONFIG));
    }
  });
});

describe('validateSelection', () => {
  const max = maxSum(CONFIG); // 27

  it('accepts a single valid number', () => {
    expect(validateSelection([13], max).valid).toBe(true);
  });

  it('accepts the full Small shortcut (0-13) and full Big shortcut (14-27)', () => {
    const small = Array.from({ length: 14 }, (_, i) => i); // 0..13
    const big = Array.from({ length: 14 }, (_, i) => i + 14); // 14..27
    expect(validateSelection(small, max).valid).toBe(true);
    expect(validateSelection(big, max).valid).toBe(true);
  });

  it('rejects an empty selection', () => {
    expect(validateSelection([], max).valid).toBe(false);
  });

  it('rejects a number outside 0..27', () => {
    expect(validateSelection([28], max).valid).toBe(false);
    expect(validateSelection([-1], max).valid).toBe(false);
  });

  it('rejects duplicates', () => {
    expect(validateSelection([5, 5], max).valid).toBe(false);
  });

  it('rejects non-array or non-integer input', () => {
    expect(validateSelection('5', max).valid).toBe(false);
    expect(validateSelection([5.5], max).valid).toBe(false);
    expect(validateSelection(null, max).valid).toBe(false);
  });
});

describe('isWinningNumber', () => {
  it('wins if the drawn sum is anywhere in the selection', () => {
    expect(isWinningNumber([3, 7, 15], 7)).toBe(true);
  });

  it('loses if the drawn sum is not in the selection', () => {
    expect(isWinningNumber([3, 7, 15], 8)).toBe(false);
  });
});

describe('computeSumDiceReward', () => {
  it('a single-number bet pays the full stake times the multiplier', () => {
    expect(computeSumDiceReward(100, 1, 9, true)).toBe(900);
  });

  it('spreading the same stake across 10 numbers divides the per-number stake, and thus the payout, by ~10', () => {
    // This is the exact scenario described: pick 1 number → big win,
    // pick 10 numbers → correspondingly smaller win, same total stake.
    const oneNumber = computeSumDiceReward(100, 1, 9, true);
    const tenNumbers = computeSumDiceReward(100, 10, 9, true);
    expect(oneNumber).toBe(900);
    expect(tenNumbers).toBe(90); // floor(100/10)=10, *9 = 90
    expect(tenNumbers).toBeLessThan(oneNumber);
  });

  it('pays nothing on a loss regardless of stake or selection count', () => {
    expect(computeSumDiceReward(100, 1, 9, false)).toBe(0);
    expect(computeSumDiceReward(100, 10, 9, false)).toBe(0);
  });

  it('floors an uneven split rather than paying out a fraction', () => {
    // 100 / 3 = 33.33... — the remainder is lost to rounding, not paid.
    expect(computeSumDiceReward(100, 3, 9, true)).toBe(33 * 9);
  });

  it('never produces a negative reward for any valid stake/selection combination', () => {
    for (let stake = 1; stake <= 1000; stake += 37) {
      for (let count = 1; count <= 28; count++) {
        expect(computeSumDiceReward(stake, count, 9, true)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('classifyResult', () => {
  const max = maxSum(CONFIG); // 27

  it('classifies the confirmed boundary correctly: 13 is Small, 14 is Big', () => {
    expect(classifyResult(13, max).size).toBe('S');
    expect(classifyResult(14, max).size).toBe('B');
  });

  it('classifies every observed real-app result correctly', () => {
    // Straight from the actual reference-app footage: 8(S/E), 11(S/O),
    // 12(S/E), 16(B/E), 24(B/E).
    expect(classifyResult(8, max)).toEqual({ size: 'S', parity: 'E' });
    expect(classifyResult(11, max)).toEqual({ size: 'S', parity: 'O' });
    expect(classifyResult(12, max)).toEqual({ size: 'S', parity: 'E' });
    expect(classifyResult(16, max)).toEqual({ size: 'B', parity: 'E' });
    expect(classifyResult(24, max)).toEqual({ size: 'B', parity: 'E' });
  });

  it('covers the extremes correctly', () => {
    expect(classifyResult(0, max)).toEqual({ size: 'S', parity: 'E' });
    expect(classifyResult(27, max)).toEqual({ size: 'B', parity: 'O' });
  });

  it('every sum in range gets exactly one size and one parity label', () => {
    for (let sum = 0; sum <= max; sum++) {
      const { size, parity } = classifyResult(sum, max);
      expect(['S', 'B']).toContain(size);
      expect(['E', 'O']).toContain(parity);
    }
  });
});

describe('computePerNumberPool', () => {
  it('attributes a single-number entry\'s full stake to that number', () => {
    const pool = computePerNumberPool([{ selection: [7], coinAmount: 100 }]);
    expect(pool.get(7)).toBe(100);
  });

  it('splits a multi-number entry\'s stake evenly, matching computeSumDiceReward\'s math', () => {
    const pool = computePerNumberPool([{ selection: [0, 1, 2, 3], coinAmount: 100 }]);
    // floor(100/4) = 25 per number — same division computeSumDiceReward would use
    expect(pool.get(0)).toBe(25);
    expect(pool.get(1)).toBe(25);
    expect(pool.get(2)).toBe(25);
    expect(pool.get(3)).toBe(25);
  });

  it('aggregates multiple entries touching the same number', () => {
    const pool = computePerNumberPool([
      { selection: [7], coinAmount: 100 },
      { selection: [7, 8], coinAmount: 50 }, // 25 to each of 7 and 8
    ]);
    expect(pool.get(7)).toBe(125); // 100 + 25
    expect(pool.get(8)).toBe(25);
  });

  it('never includes a number nobody selected', () => {
    const pool = computePerNumberPool([{ selection: [5], coinAmount: 100 }]);
    expect(pool.has(6)).toBe(false);
  });

  it('handles an empty entry list', () => {
    expect(computePerNumberPool([]).size).toBe(0);
  });
});
