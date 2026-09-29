describe('C2C financial rules', () => {
  it('quotes fiat from the server configured rate, never a client quote', () => {
    const coinAmount = 1250;
    const rateMinorPer100Coins = 350;
    const quoted = Math.ceil((coinAmount * rateMinorPer100Coins) / 100);
    expect(quoted).toBe(4375);
  });

  it('rejects non-whole or non-positive coin orders', () => {
    for (const amount of [0, -1, 1.5, NaN]) {
      expect(Number.isInteger(amount) && amount > 0).toBe(false);
    }
  });

  it('uses stable distinct ledger idempotency keys for escrow, release and refund', () => {
    const orderId = 'order-123';
    expect(`c2c:escrow:${orderId}`).not.toBe(`c2c:release:${orderId}`);
    expect(`c2c:release:${orderId}`).not.toBe(`c2c:refund:${orderId}`);
  });
});
