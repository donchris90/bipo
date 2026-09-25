// Lucky Number game math — pure, DB-free, unit-testable functions.
//
// DRAW: three digits 0-9 (uniform, independent, server-side CSPRNG — see
// RngService.randomInRange in ../rng.service.ts). The round result is only
// their sum (0-27); the digits are cosmetic.
//
// Every function here is a pure function of its inputs so the invariants in
// lucky-number-math.spec.ts (probabilities sum to 1, multipliers are whole
// numbers, RTP is never exceeded, etc.) can be checked directly, the same
// way sum-dice-rules.ts and crash-rules.ts are tested elsewhere in this
// games module.

export const MIN_SUM = 0;
export const MAX_SUM = 27;
export const DIGIT_COUNT = 3;
export const DIGIT_FACES = 10; // digits 0-9
export const TOTAL_OUTCOMES = DIGIT_FACES ** DIGIT_COUNT; // 1000
export const DEFAULT_MULTIPLIER_CAP = 1000;

/**
 * Number of ordered (d1, d2, d3) triples, each digit in [0, 9], that sum to
 * `n`. Computed by convolving the three digits' distributions rather than
 * hard-coded — this is deliberately the same technique game-rules.ts already
 * uses for `sumProbabilities` on the dice game, just fixed at 3 digits/10
 * faces here so the Lucky Number shape doesn't depend on admin config.
 */
export function sumOutcomeCounts(): Map<number, number> {
  let dist = new Map<number, number>([[0, 1]]);
  for (let digit = 0; digit < DIGIT_COUNT; digit++) {
    const next = new Map<number, number>();
    for (const [sum, ways] of dist) {
      for (let face = 0; face < DIGIT_FACES; face++) {
        next.set(sum + face, (next.get(sum + face) ?? 0) + ways);
      }
    }
    dist = next;
  }
  return dist;
}

/** p(n) = P(sum of three digits 0-9 equals n), for every n in [0, 27]. */
export function sumProbabilities(): Map<number, number> {
  const counts = sumOutcomeCounts();
  const probs = new Map<number, number>();
  for (const [n, ways] of counts) probs.set(n, ways / TOTAL_OUTCOMES);
  return probs;
}

export interface LuckyNumberConfig {
  /** Return to player, e.g. 0.95 for a 95% long-run return. (0, 1]. */
  rtp: number;
  /** Base prize a hit is designed to pay, e.g. 1000 coins. */
  basePrize: number;
  minStake: number;
  maxStake: number;
  multiplierCap?: number;
  /**
   * Applied to each number's base stake before it becomes the suggested
   * stake: weightedStake = round(baseStake ^ stakeWeightExponent). Default
   * 1 (no change — every hit pays ~basePrize, matching the plain formula
   * this module started with). The live admin panel's default is
   * 1.2798473, which shifts weight toward common numbers (their larger
   * base stake grows faster than a rare number's near-1 base stake), so a
   * hit on a common number pays more than a hit on a rare one — see
   * game-rules.ts, which is the actual source of truth for this value once
   * an admin sets it.
   */
  stakeWeightExponent?: number;
}

/**
 * m(n) = floor(RTP / p(n)), capped. Flooring (never rounding or ceiling) is
 * what guarantees the house edge on every individual number: p(n) * m(n) <=
 * RTP always, with equality only in the limit, never above it.
 */
export function computeMultipliers(rtp: number, multiplierCap = DEFAULT_MULTIPLIER_CAP): Map<number, number> {
  if (!(rtp > 0) || rtp > 1) throw new Error('rtp must be in (0, 1]');
  const probs = sumProbabilities();
  const multipliers = new Map<number, number>();
  for (const [n, p] of probs) {
    // p is always count/1000 (a clean fraction), and rtp is a config value
    // with at most a handful of decimal digits, so the true rtp/p is never
    // meant to land closer than this epsilon to a whole number. Without the
    // epsilon, floating point alone corrupts exact cases: 0.95 / 0.001
    // evaluates to 949.9999999999999 in IEEE 754, which would floor to 949
    // instead of the mathematically exact 950 — an off-by-one that would
    // silently understate that number's multiplier (and was caught by the
    // reference-table test for n=0/27 below).
    const raw = Math.floor(rtp / p + 1e-9);
    multipliers.set(n, Math.min(raw, multiplierCap));
  }
  return multipliers;
}

/**
 * Suggested stake for a single number so that hitting it pays ~basePrize:
 * s(n) = ceil(basePrize / m(n)). Ceiling (not floor/round) means the actual
 * prize on a hit, s(n) * m(n), is always >= basePrize, never short of it —
 * players never see a hit pay less than the advertised prize. This is the
 * *base* stake — see weightedStake() for the admin-configurable step that
 * (optionally) stretches it further.
 */
export function suggestedStake(multiplier: number, basePrize: number): number {
  if (multiplier <= 0) throw new Error('multiplier must be positive');
  return Math.ceil(basePrize / multiplier);
}

/**
 * Applies the admin's stakeWeightExponent to a base stake. exponent=1 is a
 * no-op (returns baseStake unchanged); the live admin default (1.2798473)
 * grows larger base stakes faster than smaller ones, so common numbers
 * (large base stake, small multiplier) end up with a bigger suggested
 * stake — and therefore a bigger prize on a hit — than rare numbers do,
 * even though rare numbers still carry the larger raw multiplier.
 */
export function weightedStake(baseStake: number, exponent = 1): number {
  return Math.max(1, Math.round(Math.pow(baseStake, exponent)));
}

export function computeSuggestedStakes(multipliers: Map<number, number>, basePrize: number, stakeWeightExponent = 1): Map<number, number> {
  const stakes = new Map<number, number>();
  for (const [n, m] of multipliers) stakes.set(n, weightedStake(suggestedStake(m, basePrize), stakeWeightExponent));
  return stakes;
}

export function suggestedTotal(selected: number[], stakes: Map<number, number>): number {
  return selected.reduce((sum, n) => sum + requireStake(stakes, n), 0);
}

function requireStake(stakes: Map<number, number>, n: number): number {
  const s = stakes.get(n);
  if (s == null) throw new Error(`No stake for number ${n}`);
  return s;
}

/**
 * Scale every picked number's stake by the same ratio so the total moves
 * toward `targetTotal`, rounding each to a whole coin with a 1-coin floor
 * (spec: "minimum 1 coin per number"). Because every stake independently
 * rounds, the realized total can drift slightly from targetTotal — callers
 * that need an exact total should re-check the returned sum, but this
 * matches the spec's "scale ... rounding to whole coins" instruction rather
 * than silently overriding the player's chosen numbers' relative weights.
 */
export function scaleStakesToTotal(
  selected: number[],
  baseStakes: Map<number, number>,
  targetTotal: number,
): Map<number, number> {
  if (selected.length === 0) return new Map();
  const baseTotal = suggestedTotal(selected, baseStakes);
  const ratio = baseTotal > 0 ? targetTotal / baseTotal : 0;
  const scaled = new Map<number, number>();
  for (const n of selected) {
    const raw = requireStake(baseStakes, n) * ratio;
    scaled.set(n, Math.max(1, Math.round(raw)));
  }
  return scaled;
}

export interface StakePlanResult {
  multipliers: Map<number, number>;
  stakes: Map<number, number>;
  total: number;
}

/**
 * Full "suggested stakes" API: given a selection and an optional requested
 * total, returns each number's stake and the resulting (rounded) total,
 * clamped to [minStake, maxStake] from config. When no requestedTotal is
 * given, the unscaled suggested stakes (each sized for `basePrize`) are
 * used as-is, then clamped as a whole if they fall outside the configured
 * bounds.
 */
export function planStakes(
  selected: number[],
  config: LuckyNumberConfig,
  requestedTotal?: number,
): StakePlanResult {
  if (selected.length === 0) throw new Error('Must select at least one number');
  const multipliers = computeMultipliers(config.rtp, config.multiplierCap);
  const baseStakes = computeSuggestedStakes(multipliers, config.basePrize, config.stakeWeightExponent ?? 1);
  const baseTotal = suggestedTotal(selected, baseStakes);

  const clampedTarget = Math.min(
    config.maxStake,
    Math.max(config.minStake, requestedTotal ?? baseTotal),
  );

  const stakes = requestedTotal == null && baseTotal >= config.minStake && baseTotal <= config.maxStake
    ? new Map(selected.map((n) => [n, requireStake(baseStakes, n)]))
    : scaleStakesToTotal(selected, baseStakes, clampedTarget);

  return { multipliers, stakes, total: suggestedTotal(selected, stakes) };
}

/** Settlement is a pure lookup — no randomness, no I/O, so it's trivially idempotent to *compute*; see lucky-number-settlement.ts for making it idempotent to *apply*. */
export function settleLuckyNumber(
  stakes: Map<number, number>,
  resultSum: number,
  multipliers: Map<number, number>,
): { won: boolean; payout: number; totalStake: number; net: number } {
  const totalStake = [...stakes.values()].reduce((a, b) => a + b, 0);
  const hitStake = stakes.get(resultSum) ?? 0;
  const multiplier = multipliers.get(resultSum) ?? 0;
  const payout = hitStake * multiplier;
  return { won: payout > 0, payout, totalStake, net: payout - totalStake };
}
