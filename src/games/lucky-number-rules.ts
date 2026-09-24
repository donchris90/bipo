import { BadRequestException } from '@nestjs/common';

export const LUCKY_NUMBER_COUNT = 28;
export const LUCKY_DICE_COUNT = 3;
export const LUCKY_DICE_SIDES = 10;
export const DEFAULT_LUCKY_RTP = 0.95;
export const DEFAULT_LUCKY_BASE_PRIZE = 1000;
// Stake-weight curve used after the probability-derived multiplier is computed.
// 1.2798473 is calibrated so a 144-coin 0-12 selection allocates 27 coins to 12.
export const DEFAULT_LUCKY_STAKE_WEIGHT_EXPONENT = 1.2798473;

export interface LuckyNumberRulesConfig {
  rtp: number;
  basePrize: number;
  stakeWeightExponent: number;
}

export interface LuckyNumberQuote {
  number: number;
  ways: number;
  probability: number;
  multiplier: number;
  suggestedStake: number;
}

export interface LuckySelection {
  numbers: number[];
  stakes: Record<string, number>;
}

export function combinationCounts(): number[] {
  const counts = Array<number>(LUCKY_NUMBER_COUNT).fill(0);
  for (let a = 0; a < 10; a++) {
    for (let b = 0; b < 10; b++) {
      for (let c = 0; c < 10; c++) counts[a + b + c]++;
    }
  }
  return counts;
}

const COUNTS = combinationCounts();

export function probabilityForNumber(number: number): number {
  if (!Number.isInteger(number) || number < 0 || number >= LUCKY_NUMBER_COUNT) throw new Error('Lucky Number must be 0-27');
  return COUNTS[number] / 1000;
}

// Use integer arithmetic for the default 95% table. This avoids the classic
// JS floating-point result where 0.95 / 0.001 becomes 949.9999999999999 and
// incorrectly floors to 949 instead of 950.
export function multiplierForNumber(number: number, rtp: number): number {
  if (!Number.isFinite(rtp) || rtp <= 0 || rtp > 1) throw new Error('RTP must be greater than 0 and at most 1');
  const ways = COUNTS[number];
  const numerator = rtp * 1000;
  return Math.min(1000, Math.floor(numerator / ways + 1e-12));
}

export function baseSuggestedStakeForNumber(number: number, basePrize: number, rtp: number): number {
  const multiplier = multiplierForNumber(number, rtp);
  return Math.max(1, Math.ceil(basePrize / multiplier));
}

export function suggestedStakeForNumber(
  number: number,
  basePrize: number,
  rtp: number,
  stakeWeightExponent = DEFAULT_LUCKY_STAKE_WEIGHT_EXPONENT,
): number {
  const baseStake = baseSuggestedStakeForNumber(number, basePrize, rtp);
  if (!Number.isFinite(stakeWeightExponent) || stakeWeightExponent <= 0) {
    throw new Error('stakeWeightExponent must be greater than 0');
  }
  // The exponent changes only the relative stake weights. The winning payout
  // remains stake × probability-derived multiplier.
  return Math.max(1, Math.round(baseStake ** stakeWeightExponent));
}

export function buildLuckyQuotes(config: LuckyNumberRulesConfig): LuckyNumberQuote[] {
  return COUNTS.map((ways, number) => ({
    number,
    ways,
    probability: ways / 1000,
    multiplier: multiplierForNumber(number, config.rtp),
    suggestedStake: suggestedStakeForNumber(number, config.basePrize, config.rtp, config.stakeWeightExponent),
  }));
}

export function validateLuckyConfig(config: Partial<LuckyNumberRulesConfig>): LuckyNumberRulesConfig {
  const rtp = config.rtp ?? DEFAULT_LUCKY_RTP;
  const basePrize = config.basePrize ?? DEFAULT_LUCKY_BASE_PRIZE;
  const stakeWeightExponent = config.stakeWeightExponent ?? DEFAULT_LUCKY_STAKE_WEIGHT_EXPONENT;
  if (!Number.isFinite(rtp) || rtp <= 0 || rtp > 1) throw new BadRequestException('rtp must be greater than 0 and at most 1');
  if (!Number.isInteger(basePrize) || basePrize < 1 || basePrize > 1_000_000_000) throw new BadRequestException('basePrize must be a whole number from 1 to 1000000000');
  if (!Number.isFinite(stakeWeightExponent) || stakeWeightExponent < 1 || stakeWeightExponent > 3) throw new BadRequestException('stakeWeightExponent must be from 1 to 3');
  return { rtp, basePrize, stakeWeightExponent };
}

export function suggestedStakes(numbers: number[], config: LuckyNumberRulesConfig): Record<string, number> {
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  return Object.fromEntries(unique.map((n) => [String(n), suggestedStakeForNumber(n, config.basePrize, config.rtp, config.stakeWeightExponent)]));
}

export function totalStake(stakes: Record<string, number>): number {
  return Object.values(stakes).reduce((sum, value) => sum + value, 0);
}

export function validateLuckySelection(selection: unknown, totalStakeSubmitted: unknown, minStake = 1, maxStake?: number): LuckySelection {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new BadRequestException('Lucky Number selection must contain numbers and stakes');
  }
  const value = selection as Partial<LuckySelection>;
  if (!Array.isArray(value.numbers) || value.numbers.length < 1 || value.numbers.length > LUCKY_NUMBER_COUNT) {
    throw new BadRequestException('Pick at least 1 and at most 28 numbers');
  }
  const numbers = value.numbers;
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n >= LUCKY_NUMBER_COUNT)) {
    throw new BadRequestException('Lucky Numbers must be whole numbers from 0 to 27');
  }
  if (new Set(numbers).size !== numbers.length) throw new BadRequestException('Lucky Number selections must not contain duplicates');
  if (!value.stakes || typeof value.stakes !== 'object' || Array.isArray(value.stakes)) {
    throw new BadRequestException('Every selected number must have its own whole-coin stake');
  }
  const stakeKeys = Object.keys(value.stakes);
  const expectedKeys = numbers.map(String).sort();
  if (stakeKeys.sort().join(',') !== expectedKeys.join(',')) {
    throw new BadRequestException('Each selected number must have exactly one stake');
  }
  const cleanStakes: Record<string, number> = {};
  for (const n of numbers) {
    const stake = Number((value.stakes as Record<string, unknown>)[String(n)]);
    if (!Number.isInteger(stake) || stake < 1) throw new BadRequestException(`Stake for number ${n} must be a whole coin amount of at least 1`);
    cleanStakes[String(n)] = stake;
  }
  const total = totalStake(cleanStakes);
  if (!Number.isInteger(totalStakeSubmitted) || totalStakeSubmitted !== total) {
    throw new BadRequestException(`Total stake must equal the sum of the selected number stakes (${total})`);
  }
  if (total < minStake) throw new BadRequestException(`Minimum total stake is ${minStake} coins`);
  if (maxStake != null && total > maxStake) throw new BadRequestException(`Maximum total stake is ${maxStake} coins`);
  return { numbers: [...numbers].sort((a, b) => a - b), stakes: cleanStakes };
}

export function scaleStakes(stakes: Record<string, number>, targetTotal: number): Record<string, number> {
  const entries = Object.entries(stakes);
  if (!entries.length) return {};
  if (!Number.isInteger(targetTotal) || targetTotal < entries.length) throw new Error('Target total must be at least one coin per selected number');
  const current = totalStake(stakes);
  if (current <= 0) return Object.fromEntries(entries.map(([key]) => [key, 1]));
  const raw = entries.map(([key, value]) => ({ key, raw: (value * targetTotal) / current }));
  const result: Record<string, number> = {};
  let assigned = 0;
  for (const item of raw) {
    const rounded = Math.max(1, Math.floor(item.raw));
    result[item.key] = rounded;
    assigned += rounded;
  }
  let delta = targetTotal - assigned;
  if (delta > 0) {
    const ranked = raw.slice().sort((a, b) => (b.raw - Math.floor(b.raw)) - (a.raw - Math.floor(a.raw)));
    let i = 0;
    while (delta > 0) { result[ranked[i % ranked.length].key]++; delta--; i++; }
  } else if (delta < 0) {
    const ranked = Object.keys(result).sort((a, b) => result[b] - result[a]);
    let i = 0;
    while (delta < 0 && i < ranked.length * 1000) {
      const key = ranked[i % ranked.length];
      if (result[key] > 1) { result[key]--; delta++; }
      i++;
    }
  }
  return result;
}

export function expectedReturnForStakes(stakes: Record<string, number>, rtp: number): number {
  const total = totalStake(stakes);
  if (!total) return 0;
  let expected = 0;
  for (const [key, stake] of Object.entries(stakes)) {
    const n = Number(key);
    expected += probabilityForNumber(n) * stake * multiplierForNumber(n, rtp);
  }
  return expected / total;
}
