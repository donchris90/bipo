import { PRIVATE_HOST_SHARE_BPS, settleBlock, splitDelivered, validateRateCard } from './private-live.pricing';

describe('private live pricing', () => {
  const start = 1_000_000;
  const min = 60_000;

  it('uses a fixed 60/40 split', () => {
    expect(PRIVATE_HOST_SHARE_BPS).toBe(6000);
    expect(splitDelivered(200)).toEqual({ hostCoins: 120, platformCoins: 80 });
    expect(splitDelivered(10)).toEqual({ hostCoins: 6, platformCoins: 4 });
    // never loses a coin to rounding
    const s = splitDelivered(333);
    expect(s.hostCoins + s.platformCoins).toBe(333);
  });

  it('pays the host in full when the time runs out', () => {
    const r = settleBlock({ priceCoins: 350, durationSeconds: 600, blockStartsAtMs: start, nowMs: start + 10 * min, viewerLeft: false });
    expect(r).toMatchObject({ refundCoins: 0, deliveredCoins: 350, hostCoins: 210, platformCoins: 140 });
  });

  it('refunds unused time pro-rata when the host ends early', () => {
    // 10 min for 350 coins, host drops after 4 minutes -> 6 of 10 minutes unused
    const r = settleBlock({ priceCoins: 350, durationSeconds: 600, blockStartsAtMs: start, nowMs: start + 4 * min, viewerLeft: false });
    expect(r.refundCoins).toBe(210);
    expect(r.deliveredCoins).toBe(140);
    expect(r.hostCoins).toBe(84);
    expect(r.hostCoins + r.platformCoins + r.refundCoins).toBe(350);
  });

  it('gives no refund when the viewer leaves early', () => {
    const r = settleBlock({ priceCoins: 350, durationSeconds: 600, blockStartsAtMs: start, nowMs: start + 1 * min, viewerLeft: true });
    expect(r).toMatchObject({ refundCoins: 0, deliveredCoins: 350, hostCoins: 210 });
  });

  it('refunds a renewal block that had not started yet in full', () => {
    const r = settleBlock({ priceCoins: 200, durationSeconds: 300, blockStartsAtMs: start + 10 * min, nowMs: start + 8 * min, viewerLeft: false });
    expect(r).toMatchObject({ refundCoins: 200, deliveredCoins: 0, hostCoins: 0, platformCoins: 0 });
  });

  it('prices each block at its own per-minute rate', () => {
    // two blocks of different value, host drops 2 minutes into the 2nd
    const a = settleBlock({ priceCoins: 100, durationSeconds: 60, blockStartsAtMs: start, nowMs: start + 3 * min, viewerLeft: false });
    const b = settleBlock({ priceCoins: 400, durationSeconds: 300, blockStartsAtMs: start + min, nowMs: start + 3 * min, viewerLeft: false });
    expect(a.refundCoins).toBe(0);
    expect(b.refundCoins).toBe(240); // 3 of 5 minutes unused at 80 coins/min
  });

  describe('rate card validation', () => {
    it('accepts and sorts a valid card', () => {
      const r = validateRateCard([{ minutes: 10, priceCoins: 350 }, { minutes: 5, priceCoins: 200 }]);
      expect(r).toEqual({
        ok: true,
        packages: [
          { minutes: 5, priceCoins: 200, description: null },
          { minutes: 10, priceCoins: 350, description: null },
        ],
      });
    });
    it('keeps a trimmed description and turns a blank one into null', () => {
      const r = validateRateCard([
        { minutes: 5, priceCoins: 200, description: '  Chat and Q&A  ' },
        { minutes: 10, priceCoins: 350, description: '   ' },
      ]);
      expect(r).toEqual({
        ok: true,
        packages: [
          { minutes: 5, priceCoins: 200, description: 'Chat and Q&A' },
          { minutes: 10, priceCoins: 350, description: null },
        ],
      });
    });
    it('rejects a description that is too long or not text', () => {
      expect(validateRateCard([{ minutes: 5, priceCoins: 200, description: 'x'.repeat(301) }]).ok).toBe(false);
      expect(validateRateCard([{ minutes: 5, priceCoins: 200, description: 42 }]).ok).toBe(false);
    });
    it.each([
      [[]],
      ['nope'],
      [[{ minutes: 0, priceCoins: 100 }]],
      [[{ minutes: 121, priceCoins: 100 }]],
      [[{ minutes: 5, priceCoins: 9 }]],
      [[{ minutes: 5.5, priceCoins: 100 }]],
      [[{ minutes: 5, priceCoins: 100 }, { minutes: 5, priceCoins: 120 }]],
      [Array.from({ length: 7 }, (_, i) => ({ minutes: i + 1, priceCoins: 50 }))],
    ])('rejects %j', (input) => {
      expect(validateRateCard(input).ok).toBe(false);
    });
  });
});
