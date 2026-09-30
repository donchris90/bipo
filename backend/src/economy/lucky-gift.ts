import { randomInt } from 'node:crypto';

export interface LuckyRewardTier {
  label: string;
  coins: number;
  /** Probability percentage, 0-100. */
  probability: number;
  /** Legacy field accepted when reading older configurations. */
  weight?: number;
}

function normalizeRows(value: unknown): Array<{ label: string; coins: number; probability: number }> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    throw new Error('Lucky rewards must contain 2-20 tiers');
  }

  const raw = value.map((r: any) => ({
    label: typeof r?.label === 'string' ? r.label.trim() : '',
    coins: Number(r?.coins),
    probability: r?.probability !== undefined ? Number(r.probability) : undefined,
    weight: r?.weight !== undefined ? Number(r.weight) : undefined,
  }));

  if (raw.some(r => !r.label || r.label.length > 40 || !Number.isInteger(r.coins) || r.coins < 0 || r.coins > 1_000_000_000)) {
    throw new Error('Each Lucky reward needs a label and whole-number coins (0-1,000,000,000)');
  }

  const hasProbability = raw.every(r => Number.isFinite(r.probability));
  if (hasProbability) {
    if (raw.some(r => r.probability! < 0 || r.probability! > 100)) {
      throw new Error('Each Lucky reward probability must be between 0% and 100%');
    }
    const total = raw.reduce((s, r) => s + r.probability!, 0);
    if (Math.abs(total - 100) > 0.001) throw new Error(`Lucky reward probabilities must total 100% (currently ${total.toFixed(2)}%)`);
    return raw.map(r => ({ label: r.label, coins: r.coins, probability: r.probability! }));
  }

  // Backward compatibility for configurations created with the old weight field.
  if (raw.some(r => !Number.isInteger(r.weight) || r.weight! < 1 || r.weight! > 1_000_000)) {
    throw new Error('Each legacy Lucky reward weight must be a whole number from 1-1,000,000');
  }
  const totalWeight = raw.reduce((s, r) => s + r.weight!, 0);
  return raw.map(r => ({ label: r.label, coins: r.coins, probability: (r.weight! / totalWeight) * 100 }));
}

/** Hard safety limits so a typo (or a compromised admin) cannot configure a coin-minting gift. */
// Expected payout may never exceed half the price paid. Creators earn a share of every coin a winner
// re-gifts, so paying out more than this loses money on the platform's margin (see the payout review).
export const LUCKY_MAX_RTP = 0.5;
/** Payouts above this are allowed but flagged in the admin as risky. Keep in sync with admin Gifts.jsx. */
export const LUCKY_WARN_RTP = 0.4;
export const LUCKY_MAX_PRIZE_MULTIPLE = 100; // no single prize above 100x the gift price

/** Expected coins returned per send, as a fraction of the price (0.615 = 61.5%). */
export function luckyPayoutRate(rewards: LuckyRewardTier[], coinPrice: number): number {
  if (!(coinPrice > 0)) return 0;
  const expected = rewards.reduce((s, r) => s + r.coins * (r.probability / 100), 0);
  return expected / coinPrice;
}

/**
 * Validates the tiers. When coinPrice is given (always, from the admin API), also enforces the
 * payout-rate and largest-prize limits above.
 */
export function validateLuckyRewards(value: unknown, coinPrice?: number): LuckyRewardTier[] {
  const rows = normalizeRows(value).map(r => ({ ...r, probability: Number(r.probability.toFixed(4)) }));
  if (coinPrice !== undefined) {
    if (!Number.isInteger(coinPrice) || coinPrice < 1) throw new Error('Lucky gifts need a valid coin price');
    const rtp = luckyPayoutRate(rows, coinPrice);
    if (rtp > LUCKY_MAX_RTP) {
      throw new Error(`Expected payout is ${(rtp * 100).toFixed(1)}% of the price; it must not exceed ${LUCKY_MAX_RTP * 100}%. Lower the win chances or the prizes.`);
    }
    const top = Math.max(...rows.map(r => r.coins));
    if (top > coinPrice * LUCKY_MAX_PRIZE_MULTIPLE) {
      throw new Error(`Largest prize (${top}) is more than ${LUCKY_MAX_PRIZE_MULTIPLE}x the gift price`);
    }
  }
  return rows;
}

export function drawLuckyReward(value: unknown): LuckyRewardTier {
  const rows = validateLuckyRewards(value);
  // Hundredths of a percent gives predictable admin-visible probabilities while
  // still using cryptographically secure randomness. The range is the sum of the
  // rounded units (not a fixed 10,000) so rounding can never leave a gap that
  // silently favours the last tier.
  const units = rows.map(r => Math.max(0, Math.round(r.probability * 100)));
  const totalUnits = units.reduce((s, u) => s + u, 0);
  let cursor = randomInt(totalUnits);
  for (let i = 0; i < rows.length; i++) {
    if (cursor < units[i]) return rows[i];
    cursor -= units[i];
  }
  return rows[rows.length - 1];
}

export function luckyGameType(value: unknown): string {
  const allowed = new Set(['mystery', 'diamond', 'gold', 'fortune', 'clover', 'jackpot']);
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(v) ? v : 'mystery';
}

// ---------------------------------------------------------------------------------------------
// Odds presets: one probability table applied to every lucky gift, with prizes expressed as
// multiples of each gift's price (0.5 = half the price back). All six bundled gifts use the same
// multiples, so a single preset fits them all.
// ---------------------------------------------------------------------------------------------

export interface LuckyOddsTier {
  /** Prize as a multiple of the gift price. 0 = no reward. */
  multiple: number;
  /** Probability percentage, 0-100. */
  probability: number;
}

/** ~36% payout, 36% win rate, 10x jackpot. Same table as migration 20261008090000. */
export const LUCKY_STANDARD_ODDS: LuckyOddsTier[] = [
  { multiple: 0, probability: 64 },
  { multiple: 0.5, probability: 22 },
  { multiple: 1, probability: 9 },
  { multiple: 2, probability: 3.5 },
  { multiple: 5, probability: 1.2 },
  { multiple: 10, probability: 0.3 },
];

export function validateOddsPreset(value: unknown): LuckyOddsTier[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) throw new Error('An odds preset needs 2-20 tiers');
  const tiers = value.map((t: any) => ({ multiple: Number(t?.multiple), probability: Number(t?.probability) }));
  if (tiers.some(t => !Number.isFinite(t.multiple) || t.multiple < 0 || t.multiple > LUCKY_MAX_PRIZE_MULTIPLE)) {
    throw new Error(`Each prize multiple must be between 0 and ${LUCKY_MAX_PRIZE_MULTIPLE}`);
  }
  if (tiers.some(t => !Number.isFinite(t.probability) || t.probability < 0 || t.probability > 100)) {
    throw new Error('Each probability must be between 0% and 100%');
  }
  const total = tiers.reduce((s, t) => s + t.probability, 0);
  if (Math.abs(total - 100) > 0.001) throw new Error(`Probabilities must total 100% (currently ${total.toFixed(2)}%)`);
  return tiers;
}

export interface LuckyOddsPlanItem {
  giftId: string;
  name: string;
  coinPrice: number;
  beforePct: number | null;
  afterPct: number | null;
  /** Present when the gift can take the preset. */
  rewards?: LuckyRewardTier[];
  /** Present when it cannot (e.g. a prize would not be a whole number of coins). */
  error?: string;
}

/**
 * Works out what every lucky gift would look like under the preset without touching the database.
 * Existing tier labels are kept by position when the gift has the same number of tiers.
 */
export function planLuckyOdds(
  gifts: Array<{ id: string; name: string; coinPrice: number; luckyRewards: unknown }>,
  preset: LuckyOddsTier[],
): LuckyOddsPlanItem[] {
  return gifts.map((g) => {
    let existing: LuckyRewardTier[] | null = null;
    let beforePct: number | null = null;
    try {
      existing = validateLuckyRewards(g.luckyRewards);
      beforePct = Number((luckyPayoutRate(existing, g.coinPrice) * 100).toFixed(2));
    } catch { /* legacy or invalid config: replaced anyway */ }
    const base = { giftId: g.id, name: g.name, coinPrice: g.coinPrice, beforePct };
    try {
      const rewards = preset.map((t, i) => {
        const raw = g.coinPrice * t.multiple;
        const coins = Math.round(raw);
        if (Math.abs(raw - coins) > 1e-6) throw new Error(`A ${t.multiple}x prize is ${raw} coins at price ${g.coinPrice}; prizes must be whole coins`);
        const label = existing && existing.length === preset.length ? existing[i].label : coins === 0 ? 'Try Again' : `${t.multiple}x back`;
        return { label, coins, probability: t.probability };
      });
      const valid = validateLuckyRewards(rewards, g.coinPrice);
      return { ...base, afterPct: Number((luckyPayoutRate(valid, g.coinPrice) * 100).toFixed(2)), rewards: valid };
    } catch (e: any) {
      return { ...base, afterPct: null, error: e?.message ?? 'Cannot apply the preset' };
    }
  });
}
