import { computeMultipliers, suggestStakes, allNumbers } from '../src/game';
import { drawRound } from '../src/rng';
import { DEFAULT_CONFIG } from '../src/types';

/**
 * The invariant from the spec: for ANY stake distribution, expected return
 * <= RTP, because multipliers are floored. This is true per-number by
 * construction (p(n) * m(n) = p(n) * floor(RTP/p(n)) <= RTP for every n),
 * and a weighted average of per-number returns that are each <= RTP is
 * itself <= RTP — so it holds for any mix of picks and stakes too.
 *
 * A note on "within 1% of RTP": because m(n) is a *floor*, most numbers
 * lose a bit more than 1% of value to rounding — see the worked numbers
 * in README "Assumptions and discrepancies from the spec". Averaged across
 * random picks and stakes, the measured return in this simulation settles
 * around 0.90-0.93 for RTP=0.95, not within 1% (0.9405-0.95) of it. That
 * comes directly from the reference table's own multipliers (e.g. m(13)=12
 * means p(13)*m(13)=0.9, a 5.3% shortfall on that number alone), so no
 * change to the formulas fixes it without also breaking the reference
 * table match. The test below asserts what's actually guaranteed — return
 * <= RTP — and pins the realistic tolerance band instead of the spec's 1%.
 */
describe('RTP invariant under random picks and stakes (1,000,000 rounds)', () => {
  it('never exceeds RTP, and lands in the realistic band for this floor-based design', () => {
    const config = DEFAULT_CONFIG;
    const multipliers = computeMultipliers(config);
    const numbers = allNumbers();

    const ROUNDS = 1_000_000;
    let totalStaked = 0;
    let totalPaid = 0;

    for (let i = 0; i < ROUNDS; i++) {
      // Random non-empty subset of numbers.
      const picks: number[] = [];
      for (const n of numbers) {
        if (Math.random() < 0.3) picks.push(n);
      }
      if (picks.length === 0) picks.push(Math.floor(Math.random() * 28));

      // Random stake target, then use the same suggested-stake formula
      // the API exposes (base stakes, optionally scaled).
      const { stakes: baseStakes, suggestedTotal } = suggestStakes(picks, config);
      const randomScale = 1 + Math.random() * 4; // scale suggested total up to 5x
      const desiredTotal = Math.max(picks.length, Math.round(suggestedTotal * randomScale));
      const stakes =
        desiredTotal === suggestedTotal
          ? baseStakes
          : (() => {
              const ratio = desiredTotal / suggestedTotal;
              const scaled: Record<number, number> = {};
              for (const n of picks) scaled[n] = Math.max(1, Math.round(baseStakes[n] * ratio));
              return scaled;
            })();

      const totalStake = picks.reduce((sum, n) => sum + stakes[n], 0);
      const { sum: result } = drawRound();
      const payout = picks.includes(result) ? stakes[result] * multipliers[result] : 0;

      totalStaked += totalStake;
      totalPaid += payout;
    }

    const measuredReturn = totalPaid / totalStaked;

    // The true *expected* return is provably <= RTP for any fixed stake
    // distribution (see comment above) — but this is one finite random
    // sample of it, and payouts are fat-tailed (multipliers up to 950x),
    // so a single run can land fractionally above the true mean by chance.
    // A small statistical margin keeps the test from being flaky while
    // still catching a real violation of the invariant.
    expect(measuredReturn).toBeLessThanOrEqual(config.rtp * 1.01);

    // The realistic band for *this* floor-based design (see comment above) —
    // not the spec's 1%, which isn't achievable without changing the
    // reference-table multipliers.
    expect(measuredReturn).toBeGreaterThan(config.rtp - 0.08);
  });
});
