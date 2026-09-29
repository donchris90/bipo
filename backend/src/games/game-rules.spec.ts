import { BadRequestException } from '@nestjs/common';
import { maxSumProbability, sameRules, shapeOf, validateGameRules } from './game-rules';

const dice = { payoutMultiplier: 9, diceCount: 3, diceSides: 10 };
const crash = { houseEdge: 0.03, growthRate: 0.1386 };

describe('maxSumProbability', () => {
  it('finds the likeliest single sum for 3 ten-sided dice (13 or 14: 75 ways of 1000)', () => {
    expect(maxSumProbability(3, 10)).toBeCloseTo(0.075, 6);
  });
  it('is 1/sides for one die', () => expect(maxSumProbability(1, 6)).toBeCloseTo(1 / 6, 9));
});

describe('validateGameRules — dice', () => {
  it('accepts the current settings and safe changes', () => {
    expect(validateGameRules(dice, dice)).toMatchObject({ payoutMultiplier: 9 });
    expect(validateGameRules(dice, { ...dice, payoutMultiplier: 12, openSeconds: 20, minStake: 5, maxStake: 5000 })).toMatchObject({ payoutMultiplier: 12, openSeconds: 20, minStake: 5, maxStake: 5000 });
  });

  it('refuses a multiplier that would let players win on average', () => {
    // best single number has probability 0.075, so 13.33x is the break-even
    expect(() => validateGameRules(dice, { ...dice, payoutMultiplier: 14 })).toThrow(/too high/);
    expect(() => validateGameRules(dice, { ...dice, payoutMultiplier: 13.4 })).toThrow(/too high/);
    expect(validateGameRules(dice, { ...dice, payoutMultiplier: 13.3 }).payoutMultiplier).toBe(13.3);
  });

  it('does not let the dice themselves be changed', () => {
    expect(() => validateGameRules(dice, { ...dice, diceCount: 4 })).toThrow(/diceCount cannot be changed/);
    expect(() => validateGameRules(dice, { ...dice, diceSides: 6 })).toThrow(/diceSides cannot be changed/);
  });

  it('rejects out-of-range and missing values', () => {
    expect(() => validateGameRules(dice, { ...dice, payoutMultiplier: 1 })).toThrow(/payoutMultiplier/);
    expect(() => validateGameRules(dice, { diceCount: 3, diceSides: 10 })).toThrow(BadRequestException);
  });
});


describe('validateGameRules — crash', () => {
  it('bounds the house edge and growth rate', () => {
    expect(validateGameRules(crash, { ...crash, houseEdge: 0.05 }).houseEdge).toBe(0.05);
    expect(() => validateGameRules(crash, { ...crash, houseEdge: 0 })).toThrow(/houseEdge/); // a zero or negative edge is a loss-maker
    expect(() => validateGameRules(crash, { ...crash, houseEdge: -0.1 })).toThrow(/houseEdge/);
    expect(() => validateGameRules(crash, { ...crash, houseEdge: 0.5 })).toThrow(/houseEdge/);
    expect(() => validateGameRules(crash, { ...crash, growthRate: 5 })).toThrow(/growthRate/);
  });
});

describe('validateGameRules — shared limits and safety', () => {
  it('rejects unknown keys instead of silently accepting typos', () => {
    expect(() => validateGameRules(dice, { ...dice, payoutMultipler: 9 })).toThrow(/Unknown setting/);
  });
  it('bounds round length and stakes, and keeps max above min', () => {
    expect(() => validateGameRules(dice, { ...dice, openSeconds: 2 })).toThrow(/openSeconds/);
    expect(() => validateGameRules(dice, { ...dice, openSeconds: 900 })).toThrow(/openSeconds/);
    expect(() => validateGameRules(dice, { ...dice, minStake: 0 })).toThrow(/minStake/);
    expect(() => validateGameRules(dice, { ...dice, minStake: 100, maxStake: 50 })).toThrow(/maxStake cannot be below/);
  });
  it('will not let a game lose its core settings', () => {
    expect(() => validateGameRules(crash, { openSeconds: 10 })).toThrow(/core settings/);
    expect(() => validateGameRules(undefined, {})).toThrow(/supported game/);
  });
  it('detects the game type from its settings', () => {
    expect(shapeOf(dice)).toBe('dice');
    expect(shapeOf(crash)).toBe('crash');
    expect(shapeOf({ payoutMultiplier: 20 })).toBe('lucky');
    expect(shapeOf({})).toBeNull();
  });
  it('compares settings regardless of key order', () => {
    expect(sameRules({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameRules({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('validateGameRules — Lucky Number 3-digit formula mode', () => {
  const lucky = { rtp: 0.95, basePrize: 1000, diceCount: 3, diceSides: 10 };

  it('accepts RTP/base-prize config without a payout multiplier', () => {
    expect(validateGameRules(lucky, { ...lucky, openSeconds: 30, minStake: 1, maxStake: 1000000 })).toMatchObject({ rtp: 0.95, basePrize: 1000, diceCount: 3, diceSides: 10 });
  });

  it('does not apply the old probability-vs-payout validation to Lucky Number', () => {
    expect(() => validateGameRules(lucky, { ...lucky, rtp: 0.95, basePrize: 1000 })).not.toThrow();
  });



  it('ignores the legacy numberPayouts map in Lucky Number formula mode', () => {
    const lucky = { diceCount: 3, diceSides: 10, rtp: 0.95, basePrize: 1000, stakeWeightExponent: 1.2798473 };
    const saved = validateGameRules(lucky, { ...lucky, numberPayouts: { '7': 999, '12': 1 } });
    expect(saved).toMatchObject({ rtp: 0.95, basePrize: 1000, stakeWeightExponent: 1.2798473, diceCount: 3, diceSides: 10 });
    expect(saved).not.toHaveProperty('numberPayouts');
  });

  it('rejects RTP outside 0..1 and non-whole base prizes', () => {
    expect(() => validateGameRules(lucky, { ...lucky, rtp: 1.01 })).toThrow(/rtp/);
    expect(() => validateGameRules(lucky, { ...lucky, basePrize: 100.5 })).toThrow(/basePrize/);
  });
});


describe('validateGameRules — Ludo', () => {
  const ludo = { minEntry: 100, maxEntry: 500000, turnSeconds: 20, reconnectSeconds: 120, prizeFirstPercent: 66.67, prizeSecondPercent: 33.33, prizeFirstPercent2p: 100, botFillSeconds: 20, botPrizePercent: 100 };

  it('detects and accepts the current Ludo rules', () => {
    expect(shapeOf(ludo)).toBe('ludo');
    expect(validateGameRules(ludo, ludo)).toMatchObject({ prizeFirstPercent: 66.67, prizeSecondPercent: 33.33, prizeFirstPercent2p: 100 });
  });

  it('requires four-player prize percentages to total 100', () => {
    expect(() => validateGameRules(ludo, { ...ludo, prizeFirstPercent: 70, prizeSecondPercent: 20 })).toThrow(/add up to 100/);
  });

  it('allows a 100% two-player first-place rule', () => {
    expect(validateGameRules(ludo, { ...ludo, prizeFirstPercent2p: 100 }).prizeFirstPercent2p).toBe(100);
  });
});
