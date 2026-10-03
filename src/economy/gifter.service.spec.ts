import { GifterService } from './gifter.service';

describe('GifterService ranking', () => {
  it('uses lifetime coins for VIP tier while ranking coins remain period-specific', async () => {
    const prisma: any = {
      giftTransaction: {
        groupBy: jest.fn()
          .mockResolvedValueOnce([{ senderId: 'u1', _sum: { coinAmount: 500 }, _count: { _all: 1 } }])
          .mockResolvedValueOnce([{ senderId: 'u1', _sum: { coinAmount: 10000 } }]),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', displayName: 'A', avatarUrl: null, countryCode: 'NG' }]) },
    };
    const result = await new GifterService(prisma).ranking('week', 10);
    expect(result[0]).toMatchObject({ coins: 500, lifetimeCoins: 10000, level: 2, tier: 'VIP 1', vip: true });
  });
});
