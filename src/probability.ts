/**
 * The sum of three independent digits 0-9 ranges over 0-27.
 * We compute the exact distribution by counting every one of the
 * 1000 equally likely (d1, d2, d3) triples — no hard-coded table.
 */

export const MIN_SUM = 0;
export const MAX_SUM = 27;
export const TOTAL_OUTCOMES = 1000; // 10 * 10 * 10

/** counts[n] = number of digit triples (d1,d2,d3) in [0,9]^3 with d1+d2+d3 === n. */
export function computeSumCounts(): number[] {
  const counts = new Array(MAX_SUM + 1).fill(0);
  for (let d1 = 0; d1 <= 9; d1++) {
    for (let d2 = 0; d2 <= 9; d2++) {
      for (let d3 = 0; d3 <= 9; d3++) {
        counts[d1 + d2 + d3]++;
      }
    }
  }
  return counts;
}

/** p(n) = counts[n] / 1000 for n in 0..27. */
export function computeProbabilities(): number[] {
  return computeSumCounts().map((c) => c / TOTAL_OUTCOMES);
}

// Computed once — the distribution never changes.
export const SUM_COUNTS = computeSumCounts();
export const PROBABILITIES = computeProbabilities();
