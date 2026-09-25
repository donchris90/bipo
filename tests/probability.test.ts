import { computeSumCounts, computeProbabilities, MIN_SUM, MAX_SUM, TOTAL_OUTCOMES } from '../src/probability';

describe('probability distribution of the three-digit sum', () => {
  it('has 28 possible sums, 0 through 27', () => {
    const counts = computeSumCounts();
    expect(counts.length).toBe(MAX_SUM - MIN_SUM + 1);
  });

  it('counts sum to exactly 1000 (all digit triples)', () => {
    const counts = computeSumCounts();
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBe(TOTAL_OUTCOMES);
  });

  it('probabilities sum to 1', () => {
    const probs = computeProbabilities();
    const total = probs.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('is symmetric around 13.5 (n and 27-n are equally likely)', () => {
    const counts = computeSumCounts();
    for (let n = 0; n <= 27; n++) {
      expect(counts[n]).toBe(counts[27 - n]);
    }
  });

  it('matches known combinatorial counts at the extremes', () => {
    const counts = computeSumCounts();
    // Only (0,0,0) sums to 0; only (9,9,9) sums to 27.
    expect(counts[0]).toBe(1);
    expect(counts[27]).toBe(1);
    // Exactly 3 ordered triples sum to 1: (1,0,0),(0,1,0),(0,0,1).
    expect(counts[1]).toBe(3);
  });
});
