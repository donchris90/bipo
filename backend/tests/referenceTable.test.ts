import { computeMultipliers, computeBaseStakes, suggestStakes, allNumbers } from '../src/game';
import { DEFAULT_CONFIG } from '../src/types';

// RTP = 0.95, base prize = 1000 — the exact config the reference table was
// generated under. Rows are given for 0-13; 14-27 are the mirror image
// (n and 27-n always share a multiplier and stake, see probability.test.ts).
const REFERENCE: Array<{ n: number; multiplier: number; stake: number }> = [
  { n: 0, multiplier: 950, stake: 2 },
  { n: 1, multiplier: 316, stake: 4 },
  { n: 2, multiplier: 158, stake: 7 },
  { n: 3, multiplier: 95, stake: 11 },
  { n: 4, multiplier: 63, stake: 16 },
  { n: 5, multiplier: 45, stake: 23 },
  { n: 6, multiplier: 33, stake: 31 },
  { n: 7, multiplier: 26, stake: 39 },
  { n: 8, multiplier: 21, stake: 48 },
  { n: 9, multiplier: 17, stake: 59 },
  { n: 10, multiplier: 15, stake: 67 },
  { n: 11, multiplier: 13, stake: 77 },
  { n: 12, multiplier: 13, stake: 77 },
  { n: 13, multiplier: 12, stake: 84 },
];

describe('reference table (RTP=0.95, base prize=1000)', () => {
  const multipliers = computeMultipliers(DEFAULT_CONFIG);
  const stakes = computeBaseStakes(DEFAULT_CONFIG);

  it.each(REFERENCE)('n=$n -> multiplier $multiplier, stake $stake', ({ n, multiplier, stake }) => {
    expect(multipliers[n]).toBe(multiplier);
    expect(stakes[n]).toBe(stake);
    // Mirror: 27-n shares the same multiplier and stake.
    expect(multipliers[27 - n]).toBe(multiplier);
    expect(stakes[27 - n]).toBe(stake);
  });

  it('picking all 28 numbers always costs more than the base prize', () => {
    const { suggestedTotal } = suggestStakes(allNumbers(), DEFAULT_CONFIG);
    expect(suggestedTotal).toBe(1090);
    expect(suggestedTotal).toBeGreaterThan(DEFAULT_CONFIG.basePrize);
  });

  /**
   * The spec asks us to also assert two things about this exact config:
   *  1. picking 7-23 gives a suggested total of 943
   *  2. picking all 28 numbers always returns less than the total stake
   *
   * Computing both directly from the formulas and the reference table
   * above (which this test already verifies matches exactly) gives
   * different numbers, so this test documents the actual, derived values
   * instead of asserting the two figures as given. See README
   * "Assumptions and discrepancies from the spec" for the full explanation:
   *
   *  1. Summing the table's stakes for n=7..23 (17 numbers) gives 972,
   *     not 943: 39+48+59+67+77+77+84+84+77+77+67+59+48+39+31+23+16 = 972.
   *     943 isn't reproducible from the given table under ceil, round, or
   *     floor rounding of s(n) = prize/m(n), so this looks like a number
   *     that doesn't match the rest of the spec rather than a bug in this
   *     implementation — flagging it rather than forcing the assertion.
   *  2. Picking all 28 does NOT always return less than the total stake.
   *     Stake x multiplier for n=0/27 is 2 x 950 = 1900, and for n=1/26 is
   *     4 x 316 = 1264 — both exceed the 1090 total stake, so landing on
   *     0, 1, 26 or 27 nets the player a profit even with every number
   *     covered. This is a direct consequence of ceil-rounding the minimum
   *     stake up for rare, high-multiplier numbers; it doesn't break the
   *     RTP invariant (see tests/simulation.test.ts — the *expected*
   *     return for covering all 28 numbers is ~92.9%, still under 95%),
   *     it just means "covered everything" isn't risk-free per round.
   */
  it('documents the derived values for the two extra spec assertions', () => {
    const picks7to23 = Array.from({ length: 17 }, (_, i) => i + 7); // 7..23 inclusive
    const { suggestedTotal: total7to23 } = suggestStakes(picks7to23, DEFAULT_CONFIG);
    expect(total7to23).toBe(972); // spec said 943; see explanation above

    const all28 = suggestStakes(allNumbers(), DEFAULT_CONFIG);
    const totalStake = all28.suggestedTotal;
    const worstCasePayout = Math.max(
      ...allNumbers().map((n) => all28.stakes[n] * multipliers[n]),
    );
    expect(worstCasePayout).toBeGreaterThan(totalStake); // spec said this never happens; it can
  });
});
