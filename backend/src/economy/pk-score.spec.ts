import { loadPkSupporters, pkPointsForCoins, pkSideForRecipient } from './pk-score';

describe('PK scoring', () => {
  const battle = { id: 'b1', challengerId: 'A', opponentId: 'B' };

  it('a gift scores for the host who RECEIVED it, whoever sent it', () => {
    expect(pkSideForRecipient(battle, 'A')).toBe('CHALLENGER');
    expect(pkSideForRecipient(battle, 'B')).toBe('OPPONENT');
    expect(pkSideForRecipient(battle, 'someone-else')).toBeNull();
  });

  it('points follow coinsPerPoint and never go negative', () => {
    expect(pkPointsForCoins(99, 1)).toBe(99n);
    expect(pkPointsForCoins(99, 10)).toBe(9n);
    expect(pkPointsForCoins(5, 10)).toBe(0n);
    expect(pkPointsForCoins(50, 0)).toBe(50n); // bad config falls back to 1
    expect(pkPointsForCoins(-5, 1)).toBe(0n);
  });

  it('supporters: top senders per side, with names', async () => {
    const prisma: any = {
      giftTransaction: {
        groupBy: jest.fn().mockResolvedValue([
          { recipientId: 'A', senderId: 'v1', _sum: { coinAmount: 500 } },
          { recipientId: 'B', senderId: 'v2', _sum: { coinAmount: 300 } },
          { recipientId: 'A', senderId: 'v3', _sum: { coinAmount: 100 } },
        ]),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', displayName: 'One', avatarUrl: null }, { id: 'v2', displayName: 'Two', avatarUrl: null }, { id: 'v3', displayName: 'Three', avatarUrl: null }]) },
    };
    const out = await loadPkSupporters(prisma, battle);
    expect(out.A.map((s) => s.userId)).toEqual(['v1', 'v3']);
    expect(out.B).toEqual([{ userId: 'v2', displayName: 'Two', avatarUrl: null, coins: 300 }]);
  });
});
