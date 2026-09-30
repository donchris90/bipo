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

export function validateLuckyRewards(value: unknown): LuckyRewardTier[] {
  return normalizeRows(value).map(r => ({ ...r, probability: Number(r.probability.toFixed(4)) }));
}

export function drawLuckyReward(value: unknown): LuckyRewardTier {
  const rows = validateLuckyRewards(value);
  // Hundredths of a percent gives predictable admin-visible probabilities while
  // still using cryptographically secure randomness.
  const totalUnits = 10_000;
  let cursor = randomInt(totalUnits);
  for (const row of rows) {
    const units = Math.max(0, Math.round(row.probability * 100));
    if (cursor < units) return row;
    cursor -= units;
  }
  return rows[rows.length - 1];
}

export function luckyGameType(value: unknown): string {
  const allowed = new Set(['mystery', 'diamond', 'gold', 'fortune', 'clover', 'jackpot']);
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(v) ? v : 'mystery';
}
