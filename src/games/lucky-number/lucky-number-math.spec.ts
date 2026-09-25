import {
  sumOutcomeCounts,
  sumProbabilities,
  computeMultipliers,
  computeSuggestedStakes,
  suggestedTotal,
  scaleStakesToTotal,
  planStakes,
  settleLuckyNumber,
  TOTAL_OUTCOMES,
  MIN_SUM,
  MAX_SUM,
  LuckyNumberConfig,
} from './lucky-number-math';

// ---------------------------------------------------------------------------
// Reference table given in the spec, for RTP = 0.95, basePrize = 1000.
// This is the ground truth the implementation is checked against below —
// every multiplier/stake pair here was hand-verified against the formulas
// (m(n) = floor(rtp/p(n)), s(n) = ceil(prize/m(n))) before being pasted in.
// ---------------------------------------------------------------------------
const REFERENCE_TABLE: Array<{ numbers: number[]; multiplier: number; stake: number }> = [
  { numbers: [0, 27], multiplier: 950, stake: 2 },
  { numbers: [1, 26], multiplier: 316, stake: 4 },
  { numbers: [2, 25], multiplier: 158, stake: 7 },
  { numbers: [3, 24], multiplier: 95, stake: 11 },
  { numbers: [4, 23], multiplier: 63, stake: 16 },
  { numbers: [5, 22], multiplier: 45, stake: 23 },
  { numbers: [6, 21], multiplier: 33, stake: 31 },
  { numbers: [7, 20], multiplier: 26, stake: 39 },
  { numbers: [8, 19], multiplier: 21, stake: 48 },
  { numbers: [9, 18], multiplier: 17, stake: 59 },
  { numbers: [10, 17], multiplier: 15, stake: 67 },
  { numbers: [11, 16], multiplier: 13, stake: 77 },
  { numbers: [12, 15], multiplier: 13, stake: 77 },
  { numbers: [13, 14], multiplier: 12, stake: 84 },
];

const CONFIG: LuckyNumberConfig = { rtp: 0.95, basePrize: 1000, minStake: 1, maxStake: 1_000_000 };

describe('sumProbabilities', () => {
  it('sums to 1 across all 28 outcomes', () => {
    const probs = sumProbabilities();
    expect(probs.size).toBe(MAX_SUM - MIN_SUM + 1);
    const total = [...probs.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('every outcome count is a positive integer and counts sum to 1000', () => {
    const counts = sumOutcomeCounts();
    let total = 0;
    for (const c of counts.values()) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThan(0);
      total += c;
    }
    expect(total).toBe(TOTAL_OUTCOMES);
  });

  it('is symmetric around the midpoint (p(n) === p(27 - n))', () => {
    const probs = sumProbabilities();
    for (let n = MIN_SUM; n <= MAX_SUM; n++) {
      expect(probs.get(n)).toBe(probs.get(MAX_SUM - n));
    }
  });
});

describe('computeMultipliers', () => {
  const multipliers = computeMultipliers(CONFIG.rtp);

  it('produces only whole numbers', () => {
    for (const m of multipliers.values()) expect(Number.isInteger(m)).toBe(true);
  });

  it('never lets a single number have positive expected value (p(n) * m(n) <= rtp)', () => {
    const probs = sumProbabilities();
    for (const [n, m] of multipliers) {
      expect(probs.get(n)! * m).toBeLessThanOrEqual(CONFIG.rtp + 1e-9);
    }
  });

  it('matches the reference table exactly for RTP = 0.95', () => {
    for (const row of REFERENCE_TABLE) {
      for (const n of row.numbers) {
        expect(multipliers.get(n)).toBe(row.multiplier);
      }
    }
  });
});

describe('computeSuggestedStakes', () => {
  const multipliers = computeMultipliers(CONFIG.rtp);
  const stakes = computeSuggestedStakes(multipliers, CONFIG.basePrize);

  it('produces only whole coins, each at least 1', () => {
    for (const s of stakes.values()) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
    }
  });

  it('matches the reference table exactly for basePrize = 1000', () => {
    for (const row of REFERENCE_TABLE) {
      for (const n of row.numbers) {
        expect(stakes.get(n)).toBe(row.stake);
      }
    }
  });

  it('every hit pays at least basePrize (ceil rounds the stake up, never down)', () => {
    for (const [n, s] of stakes) {
      expect(s * multipliers.get(n)!).toBeGreaterThanOrEqual(CONFIG.basePrize);
    }
  });

  // --------------------------------------------------------------------
  // The task asked to assert that picking 7-23 gives a suggested total of
  // 943. Computing it from the formulas above (and cross-checking by hand
  // against the reference table) gives 972, not 943:
  //   stakes(7..23) = 39+48+59+67+77+77+84+84+77+77+67+59+48+39+31+23+16
  //                 = 972
  // 943 does not fall out of any adjacent range or off-by-one variant of
  // this sum, so this looks like an arithmetic slip in the request rather
  // than a bug to reproduce — the test below asserts the value the
  // formulas actually (and correctly) produce, 972, and documents the
  // discrepancy here instead of hard-coding the requested 943.
  it('picking 7 through 23 gives a suggested total of 972 (not 943 — see comment above)', () => {
    const selected = Array.from({ length: 23 - 7 + 1 }, (_, i) => 7 + i);
    expect(suggestedTotal(selected, stakes)).toBe(972);
  });

  // --------------------------------------------------------------------
  // The task also asked to assert that picking all 28 numbers "always
  // returns less than total stake". That's true ON AVERAGE (the RTP
  // invariant below proves it), but not on every individual draw: with
  // basePrize-sized suggested stakes, the total stake for all 28 numbers
  // is 1090, while a handful of *rare* numbers pay more than that if they
  // hit — e.g. betting everything and drawing 0 pays 2 * 950 = 1900, a net
  // profit of +810 on that one round. This is inherent to sizing every
  // number's stake for the same target prize: rare numbers get a tiny
  // stake but a huge multiplier, so their single payout isn't bounded by
  // the sum of everyone else's stakes. The two tests below capture what's
  // actually true: the *expected* return across all 28 is below the total
  // stake (the house edge holds on average), while the *maximum single
  // payout* is not.
  it('all 28 numbers: expected payout is below total stake (house edge holds on average)', () => {
    const selected = Array.from({ length: MAX_SUM - MIN_SUM + 1 }, (_, i) => MIN_SUM + i);
    const total = suggestedTotal(selected, stakes);
    const probs = sumProbabilities();
    const expectedPayout = selected.reduce((sum, n) => sum + probs.get(n)! * stakes.get(n)! * multipliers.get(n)!, 0);
    expect(expectedPayout).toBeLessThan(total);
  });

  it('all 28 numbers: a rare-number hit can still pay MORE than the total stake (documented exception, not a bug)', () => {
    const selected = Array.from({ length: MAX_SUM - MIN_SUM + 1 }, (_, i) => MIN_SUM + i);
    const total = suggestedTotal(selected, stakes);
    const payoutIfZero = stakes.get(0)! * multipliers.get(0)!;
    expect(payoutIfZero).toBeGreaterThan(total);
  });
});

describe('stakeWeightExponent (admin panel default, 1.2798473)', () => {
  // These numbers were cross-checked directly against admin/src/pages/GameConfig.jsx's
  // own inline computation (same formula, independently arrived at) and its
  // test file admin/src/test/game-number-payouts.test.jsx, which asserts n=0
  // renders as "950×" / "2 🪙" — matching row 0 below exactly.
  const ADMIN_DEFAULT_EXPONENT = 1.2798473;
  const EXPECTED_WEIGHTED: Array<[number, number]> = [
    [0, 2], [1, 6], [2, 12], [3, 22], [4, 35], [5, 55], [6, 81],
    [7, 109], [8, 142], [9, 185], [10, 217], [11, 260], [12, 260], [13, 290],
  ];

  it('matches the admin panel exactly for every number 0-13 (and by symmetry 14-27)', () => {
    const multipliers = computeMultipliers(0.95);
    const weighted = computeSuggestedStakes(multipliers, 1000, ADMIN_DEFAULT_EXPONENT);
    for (const [n, expected] of EXPECTED_WEIGHTED) {
      expect(weighted.get(n)).toBe(expected);
      expect(weighted.get(MAX_SUM - n)).toBe(expected);
    }
  });

  it('exponent = 1 is a no-op (recovers the plain ceil(basePrize/multiplier) table)', () => {
    const multipliers = computeMultipliers(0.95);
    const plain = computeSuggestedStakes(multipliers, 1000, 1);
    const explicit = computeSuggestedStakes(multipliers, 1000);
    expect(plain).toEqual(explicit);
    for (const row of REFERENCE_TABLE) for (const n of row.numbers) expect(plain.get(n)).toBe(row.stake);
  });

  it('does not affect the per-number RTP invariant (stake size never changes p(n) * m(n))', () => {
    const multipliers = computeMultipliers(0.95);
    const probs = sumProbabilities();
    // The invariant is purely a function of the multiplier, not the stake,
    // so it holds identically regardless of stakeWeightExponent — sanity
    // check that weighting stakes differently didn't accidentally change
    // multipliers themselves.
    for (const [n, m] of multipliers) {
      expect(probs.get(n)! * m).toBeLessThanOrEqual(0.95 + 1e-9);
    }
  });
});

describe('scaleStakesToTotal', () => {
  const multipliers = computeMultipliers(CONFIG.rtp);
  const baseStakes = computeSuggestedStakes(multipliers, CONFIG.basePrize);

  it('keeps every scaled stake a whole number with a 1-coin floor', () => {
    const selected = [3, 7, 13, 20];
    const scaled = scaleStakesToTotal(selected, baseStakes, 5); // deliberately tiny target
    for (const s of scaled.values()) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
    }
  });

  it('moves the total toward the requested amount', () => {
    const selected = [3, 7, 13, 20];
    const base = suggestedTotal(selected, baseStakes);
    const scaledUp = scaleStakesToTotal(selected, baseStakes, base * 4);
    expect(suggestedTotal(selected, scaledUp)).toBeGreaterThan(base);
  });
});

describe('planStakes (config bounds)', () => {
  it('clamps a requested total to [minStake, maxStake]', () => {
    const config: LuckyNumberConfig = { rtp: 0.95, basePrize: 1000, minStake: 100, maxStake: 200 };
    const { total } = planStakes([13, 14], config, 5); // far below minStake
    expect(total).toBeGreaterThanOrEqual(config.minStake);
    expect(total).toBeLessThanOrEqual(config.maxStake);
  });

  it('throws if nothing is selected', () => {
    expect(() => planStakes([], CONFIG)).toThrow();
  });
});

describe('settleLuckyNumber', () => {
  const multipliers = computeMultipliers(CONFIG.rtp);

  it('pays 0 when the result is not among the picked numbers (losing bets pay 0)', () => {
    const stakes = new Map([[3, 11], [7, 39]]);
    const result = settleLuckyNumber(stakes, 20, multipliers);
    expect(result.won).toBe(false);
    expect(result.payout).toBe(0);
    expect(result.net).toBe(-result.totalStake);
  });

  it('pays stake(result) * multiplier(result) when the result is picked', () => {
    const stakes = new Map([[3, 11], [13, 84]]);
    const result = settleLuckyNumber(stakes, 13, multipliers);
    expect(result.won).toBe(true);
    expect(result.payout).toBe(84 * multipliers.get(13)!);
  });

  it('is a pure function: settling the same inputs twice gives the same payout', () => {
    const stakes = new Map([[9, 59]]);
    const a = settleLuckyNumber(stakes, 9, multipliers);
    const b = settleLuckyNumber(stakes, 9, multipliers);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Idempotent settlement, at the level a DB-backed service applies it: this
// mirrors the LOCKED -> RESOLVING conditional-claim pattern used by
// SettlementService.settle() elsewhere in this games module (see
// lucky-number-settlement.ts), using a tiny in-memory fake round instead of
// Prisma so the concurrency behaviour itself is what's under test.
// ---------------------------------------------------------------------------
describe('settlement idempotency (claim pattern)', () => {
  function makeFakeRoundStore(initialStatus: 'LOCKED' | 'SETTLED') {
    let status = initialStatus;
    let creditsApplied = 0;
    return {
      // Mirrors `updateMany({ where: { status: 'LOCKED' }, data: { status: 'RESOLVING' } })`:
      // only succeeds (count 1) if the row was still LOCKED at the moment of the call.
      claim(): number {
        if (status !== 'LOCKED') return 0;
        status = 'RESOLVING';
        return 1;
      },
      applyCreditsOnce() {
        creditsApplied += 1;
        status = 'SETTLED';
      },
      get status() {
        return status;
      },
      get creditsApplied() {
        return creditsApplied;
      },
    };
  }

  it('a round that is already SETTLED is never re-claimed or re-credited', () => {
    const store = makeFakeRoundStore('SETTLED');
    const claimed = store.claim();
    expect(claimed).toBe(0);
    expect(store.creditsApplied).toBe(0);
  });

  it('two concurrent settle attempts on the same round only ever credit once', () => {
    const store = makeFakeRoundStore('LOCKED');
    // Simulate two "workers" racing to settle the same round.
    const firstClaim = store.claim();
    const secondClaim = store.claim(); // status is already RESOLVING by now
    expect(firstClaim + secondClaim).toBe(1); // exactly one of them wins the claim

    if (firstClaim === 1) store.applyCreditsOnce();
    if (secondClaim === 1) store.applyCreditsOnce();

    expect(store.creditsApplied).toBe(1);
    expect(store.status).toBe('SETTLED');
  });
});

// ---------------------------------------------------------------------------
// Simulation invariant: for ANY mix of random picks and random stakes, the
// measured long-run return must be <= RTP, and close to it (rounding down
// on every multiplier means the realized RTP is always a little under the
// configured target, never over, and shouldn't drift far under it either).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Simulation invariant: for ANY mix of random picks and random stakes, the
// measured long-run return must never exceed RTP (flooring every multiplier
// guarantees that on every individual number, so it holds in aggregate too).
//
// The task also asked to assert the measured return stays "within 1%" of
// RTP. Running the simulation shows that does NOT hold for arbitrary
// picks/stakes here, and it isn't a bug in the math — it's a structural
// consequence of only having 28 possible outcomes with the given
// probabilities. p(n) * m(n) — the realized return contributed by number n
// alone — ranges from 0.950 (n=0/27, where p is tiny so flooring loses
// almost nothing) down to 0.897 (n=11/16, where p is large enough that
// flooring the multiplier throws away a much bigger slice of it). A player
// (or simulation) that leans on the middle of the board realizes something
// closer to ~90-94%, not 95% +/- 1%. The "within 1%" claim would only hold
// if the outcome space were much finer-grained (more digits/faces), which
// would shrink each p(n) and make the flooring loss relatively smaller
// everywhere — out of scope for this exact 3-digit/0-9 spec.
//
// So this test asserts what's actually true: the return never exceeds RTP,
// and reports the realized range so the gap above is visible rather than
// hidden by a loose tolerance.
// ---------------------------------------------------------------------------
describe('RTP invariant under random play (1,000,000 simulated rounds)', () => {
  it('measured return never exceeds RTP, and documents how far below it can land', () => {
    const config: LuckyNumberConfig = { rtp: 0.95, basePrize: 1000, minStake: 1, maxStake: 100_000 };
    const multipliers = computeMultipliers(config.rtp);
    const baseStakes = computeSuggestedStakes(multipliers, config.basePrize);
    const allNumbers = Array.from({ length: MAX_SUM - MIN_SUM + 1 }, (_, i) => MIN_SUM + i);

    const ROUNDS = 1_000_000;
    let totalStaked = 0;
    let totalPaid = 0;

    for (let round = 0; round < ROUNDS; round++) {
      // Random pick: a random non-empty subset of the 28 numbers.
      const pickCount = 1 + Math.floor(Math.random() * allNumbers.length);
      const selected = [...allNumbers].sort(() => Math.random() - 0.5).slice(0, pickCount);

      // Random total bet, scaled from the suggested stakes.
      const baseTotal = suggestedTotal(selected, baseStakes);
      const requestedTotal = Math.max(1, Math.round(baseTotal * (0.25 + Math.random() * 3)));
      const stakes = scaleStakesToTotal(selected, baseStakes, requestedTotal);

      // Real draw shape: three independent uniform digits 0-9, summed —
      // NOT a uniform pick over 0-27 — so the simulation exercises the
      // same (non-uniform) distribution the real RNG produces.
      const d1 = Math.floor(Math.random() * 10);
      const d2 = Math.floor(Math.random() * 10);
      const d3 = Math.floor(Math.random() * 10);
      const resultSum = d1 + d2 + d3;

      const { payout, totalStake } = settleLuckyNumber(stakes, resultSum, multipliers);
      totalStaked += totalStake;
      totalPaid += payout;
    }

    const measuredReturn = totalPaid / totalStaked;
    // eslint-disable-next-line no-console
    console.log(`Lucky Number simulation: measured return ${measuredReturn.toFixed(4)} vs target RTP ${config.rtp}`);
    expect(measuredReturn).toBeLessThanOrEqual(config.rtp + 0.001); // never above RTP (tiny float slack) — this is the real, unconditional invariant
  }, 30_000);

  it('per-number realized return (p(n) * m(n)) ranges from ~0.897 to 0.950 for RTP=0.95 — this is why "within 1%" is not a universal guarantee', () => {
    const multipliers = computeMultipliers(0.95);
    const probs = sumProbabilities();
    const perNumberReturn = [...probs.entries()].map(([n, p]) => p * multipliers.get(n)!);
    const min = Math.min(...perNumberReturn);
    const max = Math.max(...perNumberReturn);
    expect(max).toBeLessThanOrEqual(0.95 + 1e-9);
    expect(min).toBeGreaterThan(0.85); // sanity floor — flooring never loses more than ~10% of RTP even in the worst bucket
    expect(max - min).toBeGreaterThan(0.01); // the spread genuinely exceeds 1%, confirming "within 1%" can't hold for arbitrary picks
  });
});
