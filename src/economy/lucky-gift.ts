import { randomInt } from 'node:crypto';

export interface LuckyRewardTier {
  label: string;
  coins: number;
  weight: number;
}

export function validateLuckyRewards(value: unknown): LuckyRewardTier[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) throw new Error('Lucky rewards must contain 2-20 tiers');
  const rows = value.map((raw: any) => ({
    label: typeof raw?.label === 'string' ? raw.label.trim() : '',
    coins: Number(raw?.coins),
    weight: Number(raw?.weight),
  }));
  if (rows.some(r => !r.label || r.label.length > 40 || !Number.isInteger(r.coins) || r.coins < 0 || r.coins > 1_000_000_000 || !Number.isInteger(r.weight) || r.weight < 1 || r.weight > 1_000_000)) {
    throw new Error('Each Lucky reward needs a label, whole-number coins (0-1,000,000,000) and weight (1-1,000,000)');
  }
  if (rows.reduce((s, r) => s + r.weight, 0) > 10_000_000) throw new Error('Lucky reward weights are too large');
  return rows;
}

export function drawLuckyReward(value: unknown): LuckyRewardTier {
  const rows = validateLuckyRewards(value);
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let n = randomInt(total);
  for (const row of rows) {
    if (n < row.weight) return row;
    n -= row.weight;
  }
  return rows[rows.length - 1];
}

export function luckyGameType(value: unknown): string {
  const allowed = new Set(['mystery', 'diamond', 'gold', 'fortune', 'clover', 'jackpot']);
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(v) ? v : 'mystery';
}
