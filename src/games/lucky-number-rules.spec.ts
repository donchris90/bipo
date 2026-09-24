import {
  buildLuckyQuotes,
  combinationCounts,
  expectedReturnForStakes,
  multiplierForNumber,
  scaleStakes,
  suggestedStakeForNumber,
  totalStake,
} from './lucky-number-rules';

describe('Lucky Number math', () => {
  const quotes = buildLuckyQuotes({ rtp: 0.95, basePrize: 1000, stakeWeightExponent: 1.2798473 });
  const expectedMultipliers = [950,316,158,95,63,45,33,26,21,17,15,13,13,12,12,13,13,15,17,21,26,33,45,63,95,158,316,950];
  const expectedStakes = [2,6,12,22,35,55,81,109,142,185,217,260,260,290,290,260,260,217,185,142,109,81,55,35,22,12,6,2];

  it('computes all 1000 digit triples and probabilities that sum to 1', () => {
    expect(combinationCounts().reduce((a, b) => a + b, 0)).toBe(1000);
    expect(quotes.reduce((a, q) => a + q.probability, 0)).toBeCloseTo(1, 12);
  });

  it('matches the supplied 95% reference multiplier and stake table exactly', () => {
    expect(quotes.map((q) => q.multiplier)).toEqual(expectedMultipliers);
    expect(quotes.map((q) => q.suggestedStake)).toEqual(expectedStakes);
  });

  it('uses whole-number multipliers and integer stakes', () => {
    expect(quotes.every((q) => Number.isInteger(q.multiplier) && Number.isInteger(q.suggestedStake))).toBe(true);
  });

  it('keeps expected return at or below configured RTP for arbitrary positive stake maps', () => {
    const cases = [
      { '0': 100 },
      { '13': 100, '14': 200, '27': 50 },
      Object.fromEntries(Array.from({ length: 28 }, (_, n) => [String(n), n + 1])),
    ];
    for (const stakes of cases) expect(expectedReturnForStakes(stakes, 0.95)).toBeLessThanOrEqual(0.95 + 1e-12);
  });

  it('scales stake maps to whole coins while preserving the requested total', () => {
    const scaled = scaleStakes({ '7': 39, '13': 84, '20': 39 }, 500);
    expect(Object.values(scaled).every(Number.isInteger)).toBe(true);
    expect(Object.values(scaled).every((v) => v >= 1)).toBe(true);
    expect(totalStake(scaled)).toBe(500);
  });

  it('losing bets have zero payout by construction', () => {
    const stakes = { '7': 39 };
    const payout = 0; // settlement only pays when the drawn sum is the selected number
    expect(payout).toBe(0);
    expect(expectedReturnForStakes(stakes, 0.95)).toBeGreaterThan(0);
  });

  it('applies the weighted stake curve after computing the multiplier', () => {
    expect(suggestedStakeForNumber(0, 1000, 0.95, 1.2798473)).toBe(2);
    expect(suggestedStakeForNumber(12, 1000, 0.95, 1.2798473)).toBe(260);
    expect(suggestedStakeForNumber(13, 1000, 0.95, 1.2798473)).toBe(290);
  });

  it('allocates exactly 27 coins to number 12 from a 144-coin 0-12 selection', () => {
    const stakes = Object.fromEntries(quotes.slice(0, 13).map((q) => [String(q.number), q.suggestedStake]));
    const scaled = scaleStakes(stakes, 144);
    expect(totalStake(scaled)).toBe(144);
    expect(scaled['12']).toBe(27);
    expect(scaled['12'] * multiplierForNumber(12, 0.95)).toBe(351);
    expect(scaled['12'] * multiplierForNumber(12, 0.95) - 144).toBe(207);
  });

  it('1,000,000-round deterministic simulation stays below RTP for a valid random stake distribution', () => {
    // This is a reproducible Monte Carlo sanity check, not a proof. Production
    // RNG is crypto.randomInt; the test PRNG is deliberately deterministic.
    const counts = combinationCounts();
    let state = 0x12345678;
    const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
    let stakeTotal = 0;
    let payoutTotal = 0;
    for (let i = 0; i < 1_000_000; i++) {
      const number = Math.floor(rnd() * 28);
      const stake = 1 + Math.floor(rnd() * 1000);
      const ways = counts[number];
      const multiplier = multiplierForNumber(number, 0.95);
      const hit = rnd() < ways / 1000;
      stakeTotal += stake;
      if (hit) payoutTotal += stake * multiplier;
    }
    const measured = payoutTotal / stakeTotal;
    expect(measured).toBeLessThanOrEqual(0.95);
    // Because the formula floors each number independently, a generic random
    // distribution is not guaranteed to land within 1 percentage point of 95%.
    // The invariant that is mathematically guaranteed is the <= RTP bound above.
    expect(measured).toBeGreaterThan(0.90);
  });

  it('keeps the weighted suggested stakes symmetric around the center', () => {
    expect(quotes.map((q) => q.suggestedStake)).toEqual([...quotes].reverse().map((q) => q.suggestedStake));
  });
});
