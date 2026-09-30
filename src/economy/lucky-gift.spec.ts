import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawLuckyReward, luckyGameType, luckyPayoutRate, validateLuckyRewards } from './lucky-gift';

const tiers = [
  { label: 'Try Again', coins: 0, probability: 50 },
  { label: 'Small', coins: 5, probability: 25 },
  { label: 'Good', coins: 20, probability: 25 },
];

describe('lucky gifts', () => {
  it('validates reward tiers (legacy weights still accepted)', () => {
    expect(validateLuckyRewards([{ label: 'Try Again', coins: 0, weight: 35 }, { label: 'Jackpot', coins: 1000, weight: 1 }])).toHaveLength(2);
  });
  it('rejects invalid weights', () => {
    expect(() => validateLuckyRewards([{ label: 'x', coins: 1, weight: 0 }, { label: 'y', coins: 2, weight: 1 }])).toThrow();
  });
  it('requires probabilities to total 100%', () => {
    expect(() => validateLuckyRewards([{ label: 'a', coins: 0, probability: 60 }, { label: 'b', coins: 1, probability: 30 }])).toThrow(/100%/);
  });
  it('normalizes supported game types', () => {
    expect(luckyGameType('Golden')).toBe('mystery');
    expect(luckyGameType('gold')).toBe('gold');
  });

  describe('payout safety limits', () => {
    it('computes the expected payout rate', () => {
      expect(luckyPayoutRate(validateLuckyRewards(tiers), 10)).toBeCloseTo(0.625, 5); // (5*.25+20*.25)/10
    });
    it('rejects a configuration that pays out more than it costs', () => {
      expect(() => validateLuckyRewards(tiers, 5)).toThrow(/must not exceed/);
    });
    it('rejects a single prize above 100x the price', () => {
      const big = [{ label: 'none', coins: 0, probability: 99.99 }, { label: 'huge', coins: 2_000_000, probability: 0.01 }];
      // Payout rate is only 2%, so the prize-size limit is the one that trips.
      expect(() => validateLuckyRewards(big, 10_000)).toThrow(/100x/);
    });
    it('accepts a sane configuration', () => {
      expect(validateLuckyRewards(tiers, 10)).toHaveLength(3);
    });
  });

  describe('draw', () => {
    it('always returns one of the configured tiers', () => {
      for (let i = 0; i < 500; i++) expect(tiers.map(t => t.label)).toContain(drawLuckyReward(tiers).label);
    });
    it('follows the configured probabilities', () => {
      const n = 20_000;
      let empty = 0;
      for (let i = 0; i < n; i++) if (drawLuckyReward(tiers).coins === 0) empty++;
      expect(empty / n).toBeGreaterThan(0.47);
      expect(empty / n).toBeLessThan(0.53);
    });
    it('does not favour the last tier when probabilities do not divide evenly', () => {
      const thirds = [
        { label: 'a', coins: 0, probability: 33.3333 },
        { label: 'b', coins: 1, probability: 33.3333 },
        { label: 'c', coins: 2, probability: 33.3334 },
      ];
      const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
      const n = 30_000;
      for (let i = 0; i < n; i++) counts[drawLuckyReward(thirds).label]++;
      for (const k of Object.keys(counts)) expect(counts[k] / n).toBeGreaterThan(0.31);
    });
    it('never returns a zero-probability tier', () => {
      const t = [{ label: 'a', coins: 0, probability: 100 }, { label: 'b', coins: 9, probability: 0 }];
      for (let i = 0; i < 500; i++) expect(drawLuckyReward(t).label).toBe('a');
    });
  });

  describe('bundled catalog migration', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20260930103000_seed_lucky_gift_catalog/migration.sql'), 'utf8');
    it('runs after the migration that adds the lucky columns', () => {
      const dirs = require('node:fs').readdirSync(join(__dirname, '../../prisma/migrations')) as string[];
      const add = dirs.find(d => d.endsWith('_lucky_gifts'))!;
      const seed = dirs.find(d => d.endsWith('_seed_lucky_gift_catalog'))!;
      expect(seed > add).toBe(true);
    });
    it('every seeded gift is within the payout limits', () => {
      const rows = [...sql.matchAll(/'(RRYDA_[A-Z_]+)', '[^']+', (\d+),.*?'(\[.*?\])'::jsonb/g)];
      expect(rows.length).toBe(6);
      for (const [, code, price, json] of rows) {
        expect(() => validateLuckyRewards(JSON.parse(json.replace(/\\"/g, '"')), Number(price))).not.toThrow();
        expect(code).toMatch(/^RRYDA_/);
      }
    });
  });
  describe('payout-lowering migration', () => {
    const dir = join(__dirname, '../../prisma/migrations/20261008090000_lucky_gift_lower_payout');
    const sql = readFileSync(join(dir, 'migration.sql'), 'utf8');
    const rows = [...sql.matchAll(/\('(RRYDA_[A-Z_]+)', '(\[.*?\])'\)/g)];
    it('covers all six bundled gifts', () => {
      expect(rows.length).toBe(6);
    });
    it('keeps every gift valid and at about 36% payout with a 10x jackpot', () => {
      const prices: Record<string, number> = { RRYDA_LUCKY_CLOVER: 10, RRYDA_MYSTERY_BOX: 50, RRYDA_DIAMOND_CHEST: 100, RRYDA_GOLDEN_CHEST: 500, RRYDA_FORTUNE: 1000, RRYDA_JACKPOT: 5000 };
      for (const [, code, json] of rows) {
        const price = prices[code];
        const tiers = validateLuckyRewards(JSON.parse(json), price);
        expect(luckyPayoutRate(tiers, price)).toBeCloseTo(0.36, 3);
        expect(Math.max(...tiers.map(t => t.coins))).toBe(price * 10);
        expect(tiers.filter(t => t.coins === 0)[0].probability).toBe(64);
      }
    });
    it('runs after the earlier lucky migrations', () => {
      const dirs = require('node:fs').readdirSync(join(__dirname, '../../prisma/migrations')) as string[];
      const mine = '20261008090000_lucky_gift_lower_payout';
      for (const d of dirs.filter(d => d.includes('lucky'))) if (d !== mine) expect(d < mine).toBe(true);
    });
  });
});
