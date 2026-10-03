import { BadRequestException } from '@nestjs/common';
import { ReferralConfigService, parseReferralReward, DEFAULT_REFERRAL_REWARD_COINS } from './referral-config.service';

describe('ReferralConfigService', () => {
  const mk = (row: any, over: any = {}) => {
    const prisma: any = { referralConfig: { findUnique: jest.fn().mockResolvedValue(row), upsert: jest.fn().mockImplementation(async (a: any) => ({ ...a.create, updatedAt: new Date() })), ...over } };
    const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
    return { svc: new ReferralConfigService(prisma, audit), prisma, audit };
  };

  it('falls back to 100 when no row exists', async () => {
    expect(await mk(null).svc.getRewardCoins()).toBe(DEFAULT_REFERRAL_REWARD_COINS);
  });

  it('falls back to 100 if the table is unavailable', async () => {
    const { svc } = mk(null, { findUnique: jest.fn().mockRejectedValue(new Error('no table')) });
    expect(await svc.getRewardCoins()).toBe(100);
  });

  it('returns the configured value', async () => {
    expect(await mk({ rewardCoins: 250 }).svc.getRewardCoins()).toBe(250);
  });

  it.each([-1, 1.5, 'abc', null, undefined, '', 100_001])('rejects invalid reward %p', (v) => {
    expect(() => parseReferralReward(v)).toThrow(BadRequestException);
  });

  it('accepts 0 (disables the reward) and the max', () => {
    expect(parseReferralReward(0)).toBe(0);
    expect(parseReferralReward(100_000)).toBe(100_000);
  });

  it('updates and writes an audit record with before/after', async () => {
    const { svc, audit, prisma } = mk({ rewardCoins: 100 });
    const res = await svc.updateRewardCoins(300, 'admin1');
    expect(prisma.referralConfig.upsert).toHaveBeenCalled();
    expect(res.rewardCoins).toBe(300);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'referral.reward_updated', metadata: { before: 100, after: 300 } }));
  });
});
