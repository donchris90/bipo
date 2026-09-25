import { MAX_SUM, PROBABILITIES, SUM_COUNTS } from './probability';
import { GameConfig, StakeMap } from './types';

/**
 * IEEE-754 floats can't represent decimals like 0.95 or thirds exactly,
 * so a value that is mathematically an integer (e.g. RTP/p(0) = 950)
 * can come out as 949.999999999999. A tiny epsilon before flooring/ceiling
 * fixes that without meaningfully affecting any non-boundary case.
 * This matches the reference table exactly (see tests/referenceTable.test.ts).
 */
const EPSILON = 1e-9;

/** m(n) = floor(RTP / p(n)), capped at config.multiplierCap. Whole numbers only. */
export function computeMultiplier(probability: number, config: GameConfig): number {
  if (probability <= 0) return 0; // unreachable for n in 0..27, guards div-by-zero
  const raw = config.rtp / probability;
  const floored = Math.floor(raw + EPSILON);
  return Math.min(floored, config.multiplierCap);
}

/** m(n) for every n in 0..27. */
export function computeMultipliers(config: GameConfig): number[] {
  return PROBABILITIES.map((p) => computeMultiplier(p, config));
}

/** s(n) = ceil(basePrize / m(n)), minimum 1 coin. */
export function computeBaseStake(multiplier: number, config: GameConfig): number {
  if (multiplier <= 0) return config.maxTotalStake; // degenerate guard, never hit for n in 0..27
  const raw = config.basePrize / multiplier;
  return Math.max(1, Math.ceil(raw - EPSILON));
}

/** s(n) for every n in 0..27. */
export function computeBaseStakes(config: GameConfig): number[] {
  const multipliers = computeMultipliers(config);
  return multipliers.map((m) => computeBaseStake(m, config));
}

export interface SuggestedStakes {
  stakes: StakeMap;
  suggestedTotal: number;
}

/** Suggested per-number stakes for a set of picks, before any player scaling. */
export function suggestStakes(picks: number[], config: GameConfig): SuggestedStakes {
  const multipliers = computeMultipliers(config);
  const stakes: StakeMap = {};
  let suggestedTotal = 0;
  for (const n of picks) {
    const s = computeBaseStake(multipliers[n], config);
    stakes[n] = s;
    suggestedTotal += s;
  }
  return { stakes, suggestedTotal };
}

/**
 * Scales every stake by the same ratio so the total hits `desiredTotal`,
 * rounding each to a whole number of coins with a floor of 1 coin per number.
 * Because rounding is not exact, the returned total may differ from
 * desiredTotal by a few coins — callers should re-sum the returned stakes
 * rather than assume it lands exactly on desiredTotal.
 */
export function scaleStakes(stakes: StakeMap, desiredTotal: number): StakeMap {
  const picks = Object.keys(stakes).map(Number);
  const currentTotal = picks.reduce((sum, n) => sum + stakes[n], 0);
  if (currentTotal <= 0) return { ...stakes };
  const ratio = desiredTotal / currentTotal;
  const scaled: StakeMap = {};
  for (const n of picks) {
    scaled[n] = Math.max(1, Math.round(stakes[n] * ratio));
  }
  return scaled;
}

export function sumStakes(stakes: StakeMap): number {
  return Object.values(stakes).reduce((a, b) => a + b, 0);
}

/** All valid picks, 0..27. */
export function allNumbers(): number[] {
  return Array.from({ length: MAX_SUM + 1 }, (_, i) => i);
}

export { SUM_COUNTS };
