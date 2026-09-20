import { computeGiftSplit } from './gift.service';

describe('computeGiftSplit', () => {
  it('splits by basis points with the platform absorbing the floor() remainder', () => {
    // 70/30 split of 100 coins — exact, no rounding involved
    expect(computeGiftSplit(100, { creatorShareBps: 7000, platformShareBps: 3000, agencyShareBps: 0 })).toEqual({
      creatorShare: 70,
      platformShare: 30,
      agencyShare: 0,
    });
  });

  it('never loses or invents coins to rounding — shares always sum to the original amount', () => {
    // 7 coins at 70% doesn't divide evenly (4.9) — floor() rounds the
    // creator's share down, platform takes the remainder rather than also
    // flooring, so nothing leaks.
    const { creatorShare, platformShare } = computeGiftSplit(7, {
      creatorShareBps: 7000,
      platformShareBps: 3000,
      agencyShareBps: 0,
    });
    expect(creatorShare + platformShare).toBe(7);
    expect(creatorShare).toBe(4); // floor(7 * 0.7) = floor(4.9) = 4
    expect(platformShare).toBe(3);
  });

  it('handles a 100% creator share (0 platform)', () => {
    const result = computeGiftSplit(50, { creatorShareBps: 10000, platformShareBps: 0, agencyShareBps: 0 });
    expect(result).toEqual({ creatorShare: 50, platformShare: 0, agencyShare: 0 });
  });

  it('handles a 0% creator share (100% platform)', () => {
    const result = computeGiftSplit(50, { creatorShareBps: 0, platformShareBps: 10000, agencyShareBps: 0 });
    expect(result).toEqual({ creatorShare: 0, platformShare: 50, agencyShare: 0 });
  });

  it('never produces a negative share for any coin amount from 1 to 1000 at a 70% split', () => {
    for (let coins = 1; coins <= 1000; coins++) {
      const { creatorShare, platformShare } = computeGiftSplit(coins, {
        creatorShareBps: 7000,
        platformShareBps: 3000,
        agencyShareBps: 0,
      });
      expect(creatorShare).toBeGreaterThanOrEqual(0);
      expect(platformShare).toBeGreaterThanOrEqual(0);
      expect(creatorShare + platformShare).toBe(coins);
    }
  });

  describe('with an agency commission', () => {
    const split = { creatorShareBps: 7000, platformShareBps: 3000, agencyShareBps: 0 };

    it('takes the commission out of the creator pool, leaving platform share untouched', () => {
      // 100 coins, 70% creator pool = 70. 20% agency commission of that
      // pool = 14. Creator nets 56, platform still gets its fixed 30.
      const result = computeGiftSplit(100, split, 2000);
      expect(result).toEqual({ creatorShare: 56, platformShare: 30, agencyShare: 14 });
      expect(result.creatorShare + result.platformShare + result.agencyShare).toBe(100);
    });

    it('agencyShare is 0 when commissionBps is 0 (no agency), identical to the no-agency case', () => {
      expect(computeGiftSplit(100, split, 0)).toEqual(computeGiftSplit(100, split));
    });

    it('never lets creator+agency exceed the original creator pool, across a range of commissions', () => {
      for (const commissionBps of [0, 500, 1000, 2500, 5000, 9999, 10000]) {
        const { creatorShare, agencyShare } = computeGiftSplit(1000, split, commissionBps);
        expect(creatorShare + agencyShare).toBe(700); // the fixed 70% creator pool for this split
        expect(creatorShare).toBeGreaterThanOrEqual(0);
        expect(agencyShare).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
