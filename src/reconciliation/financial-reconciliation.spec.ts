import { buildExpectedLedgerKeys, buildExpectedLedgerMovements } from './financial-reconciliation';

describe('financial reconciliation contracts', () => {
  it('requires every gift money movement, including lucky bonus expense', () => {
    expect(buildExpectedLedgerKeys({
      category: 'GIFT',
      data: {
        id: 'gift-1',
        coinAmount: 100,
        idempotencyKey: 'g1',
        creatorShareCoins: 70,
        platformShareCoins: 30,
        agencyShareCoins: 0,
        luckyRewardCoins: 20,
      },
    })).toEqual([
      'gift_sent:g1',
      'gift_received:g1',
      'gift_platform:g1',
      'gift_lucky_bonus:g1',
      'gift_lucky_platform:g1',
    ]);
    expect(buildExpectedLedgerMovements({ category: 'GIFT', data: { idempotencyKey: 'g1', coinAmount: 100, creatorShareCoins: 70, platformShareCoins: 30, agencyShareCoins: 0, luckyRewardCoins: 20 } })[0]).toEqual({ key: 'gift_sent:g1', amount: -100n });
  });

  it('requires purchase funding only after confirmation', () => {
    expect(buildExpectedLedgerKeys({ category: 'COIN_PURCHASE', data: { id: 'p1', status: 'PENDING' } })).toEqual([]);
    expect(buildExpectedLedgerKeys({ category: 'COIN_PURCHASE', data: { id: 'p1', status: 'CONFIRMED', coinAmount: 500 } })).toEqual(['coin_purchase:p1']);
    expect(buildExpectedLedgerKeys({ category: 'COIN_PURCHASE', data: { id: 'p1', status: 'CHARGEBACK', coinAmount: 500 } })).toEqual(['coin_purchase:p1']);
  });

  it('requires a withdrawal reserve and a release only after funds return', () => {
    expect(buildExpectedLedgerKeys({ category: 'WITHDRAWAL', data: { id: 'w1', idempotencyKey: 'k1', amountMinor: 250, status: 'PROCESSING' } }))
      .toEqual(['withdrawal_reserve:k1']);
    expect(buildExpectedLedgerKeys({ category: 'WITHDRAWAL', data: { id: 'w1', idempotencyKey: 'k1', amountMinor: 250, status: 'REVERSED' } }))
      .toEqual(['withdrawal_reserve:k1', 'withdrawal_release:k1']);
  });
});
