import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  drawLuckyReward, luckyGameType, luckyPayoutRate, validateLuckyRewards,
  LUCKY_MAX_RTP, LUCKY_MAX_PRIZE_MULTIPLE, LUCKY_STANDARD_ODDS, planLuckyOdds, validateOddsPreset,
} from './lucky-gift';

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
      expect(validateLuckyRewards(tiers, 20)).toHaveLength(3); // 31.25% payout
    });
    it('caps the expected payout at 50% of the price', () => {
      expect(LUCKY_MAX_RTP).toBe(0.5);
      // tiers pay 62.5% at price 10: fine before the cap existed, refused now.
      expect(() => validateLuckyRewards(tiers, 10)).toThrow(/must not exceed 50%/);
      // exactly 50% is allowed
      expect(validateLuckyRewards([{ label: 'none', coins: 0, probability: 50 }, { label: 'back', coins: 10, probability: 50 }], 10)).toHaveLength(2);
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
    it('every seeded gift is structurally valid and within the prize-size limit', () => {
      // The original seed pays ~61.5%, above today's payout cap; migration 20261008090000 lowers it.
      // So check structure and prize size here, not the cap.
      const rows = [...sql.matchAll(/'(RRYDA_[A-Z_]+)', '[^']+', (\d+),.*?'(\[.*?\])'::jsonb/g)];
      expect(rows.length).toBe(6);
      for (const [, code, price, json] of rows) {
        const rewards = validateLuckyRewards(JSON.parse(json.replace(/\\"/g, '"')));
        expect(Math.max(...rewards.map(r => r.coins))).toBeLessThanOrEqual(Number(price) * LUCKY_MAX_PRIZE_MULTIPLE);
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
  describe('odds presets', () => {
    const gift = (id: string, price: number, luckyRewards: unknown = null) => ({ id, name: `Gift ${id}`, coinPrice: price, luckyRewards });

    it('the standard preset is valid, pays 36% and keeps a 10x jackpot', () => {
      const preset = validateOddsPreset(LUCKY_STANDARD_ODDS);
      const rate = preset.reduce((sum, t) => sum + t.multiple * (t.probability / 100), 0);
      expect(rate).toBeCloseTo(0.36, 5);
      expect(Math.max(...preset.map(t => t.multiple))).toBe(10);
      expect(rate).toBeLessThanOrEqual(LUCKY_MAX_RTP);
    });

    it('rejects a malformed preset', () => {
      expect(() => validateOddsPreset([{ multiple: 0, probability: 60 }, { multiple: 1, probability: 30 }])).toThrow(/100%/);
      expect(() => validateOddsPreset([{ multiple: -1, probability: 50 }, { multiple: 1, probability: 50 }])).toThrow(/multiple/);
      expect(() => validateOddsPreset([{ multiple: 1000, probability: 50 }, { multiple: 1, probability: 50 }])).toThrow(/multiple/);
      expect(() => validateOddsPreset('nope')).toThrow(/2-20/);
    });

    it('applies to every gift, keeping labels and scaling prizes by price', () => {
      const old = [
        { label: 'Empty', coins: 0, probability: 50 }, { label: 'A', coins: 25, probability: 25 }, { label: 'B', coins: 50, probability: 15 },
        { label: 'C', coins: 100, probability: 7 }, { label: 'D', coins: 250, probability: 2 }, { label: 'Jackpot', coins: 500, probability: 1 },
      ];
      const [r] = planLuckyOdds([gift('1', 50, old)], LUCKY_STANDARD_ODDS);
      expect(r.error).toBeUndefined();
      expect(r.beforePct).toBeCloseTo(61.5, 1);
      expect(r.afterPct).toBeCloseTo(36, 1);
      expect(r.rewards!.map(x => x.label)).toEqual(['Empty', 'A', 'B', 'C', 'D', 'Jackpot']);
      expect(r.rewards!.map(x => x.coins)).toEqual([0, 25, 50, 100, 250, 500]);
    });

    it('uses generic labels when the tier count differs', () => {
      const [r] = planLuckyOdds([gift('1', 100, null)], LUCKY_STANDARD_ODDS);
      expect(r.rewards![0].label).toBe('Try Again');
      expect(r.rewards![5].label).toBe('10x back');
    });

    it('skips a gift when a prize would not be a whole number of coins', () => {
      const [r] = planLuckyOdds([gift('odd', 1)], LUCKY_STANDARD_ODDS); // 0.5x of 1 coin
      expect(r.rewards).toBeUndefined();
      expect(r.error).toMatch(/whole coins/);
    });

    it('skips a gift when the preset would exceed the payout cap, but not the others', () => {
      const generous = [{ multiple: 0, probability: 10 }, { multiple: 2, probability: 90 }];
      const out = planLuckyOdds([gift('1', 10)], generous);
      expect(out[0].error).toMatch(/must not exceed 50%/);
      const mixed = planLuckyOdds([gift('1', 10), gift('2', 1)], LUCKY_STANDARD_ODDS);
      expect(mixed.find(m => m.giftId === '1')!.rewards).toBeDefined();
      expect(mixed.find(m => m.giftId === '2')!.error).toBeDefined();
    });
  });

  describe('payout-lowering migration guard', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261008090000_lucky_gift_lower_payout/migration.sql'), 'utf8');
    it('only rewrites gifts whose payout is still above 50%', () => {
      expect(sql).toMatch(/> 0\.5/);
      expect(sql).toMatch(/"luckyEnabled" = true/);
    });
  });
});
