import { UsersService } from './users.service';

describe('referral reward exposure', () => {
  it('returns the referral list with the admin-configured reward amount', async () => {
    const rows = [{ id: 'u2', displayName: 'Ada', createdAt: new Date('2026-01-01') }];
    const prisma: any = { user: { findMany: jest.fn().mockResolvedValue(rows) } };
    const referralConfig: any = { getRewardCoins: jest.fn().mockResolvedValue(250) };
    const svc = new (UsersService as any)(prisma, {}, {}, {}, {}, {}, {}, referralConfig);
    const res = await svc.findMyReferrals('u1');
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { referredById: 'u1' } }));
    expect(res).toEqual({ referrals: rows, referralBonusCoins: 250 });
  });
});
