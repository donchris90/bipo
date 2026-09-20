import { BadRequestException } from '@nestjs/common';
import { WithdrawalService } from './withdrawal.service';
import { MockPayoutProvider } from './providers/payout-provider.interface';
import { quoteWithdrawal } from '../payouts/payout-math';

const RULES = { minorPer100Coins: 5000, minWithdrawalCoins: 1000, maxWithdrawalCoins: null, feeBps: 200, feeFlatMinor: 5000 };
const ACCOUNT = { provider: 'PAYSTACK', bankName: 'GTBank', accountLast4: '1234', accountName: 'ADA OBI', recipientCode: 'RCP_abc' };

function build(over: { account?: any; quote?: (country: string, coins: number) => Promise<any>; balance?: bigint; verified?: boolean } = {}) {
  const created: any[] = [];
  const tx = { withdrawalRequest: { create: jest.fn(async ({ data }: any) => { created.push(data); return { id: 'w1', ...data }; }) } };
  const prisma: any = {
    withdrawalRequest: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(async () => ({ id: 'w1', creatorId: 'u1', walletType: 'CREATOR_EARNINGS', amountMinor: 1000, currencyCode: 'NGN', idempotencyKey: 'k', ...created[0] })),
      update: jest.fn(async ({ data }: any) => ({ id: 'w1', ...data })),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ kycVerified: over.verified ?? true }) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const wallet: any = { getBalance: jest.fn().mockResolvedValue(over.balance ?? 10_000n), debit: jest.fn() };
  const risk: any = { scoreWithdrawal: jest.fn().mockResolvedValue({ needsReview: true, reasons: [] }) };
  const payoutConfig: any = { requireQuote: jest.fn(over.quote ?? (async (_c: string, coins: number) => ({ currencyCode: 'NGN', ...quoteWithdrawal(coins, RULES) }))) };
  const payoutAccounts: any = {
    requireFor: jest.fn(async () => {
      if (over.account === null) throw new BadRequestException('Add a payout account before withdrawing');
      return over.account ?? ACCOUNT;
    }),
  };
  const svc = new WithdrawalService(prisma, wallet, { record: jest.fn() } as any, risk, new MockPayoutProvider(), { notifyOnce: jest.fn() } as any, payoutConfig, payoutAccounts);
  return { svc, prisma, wallet, tx, created, payoutConfig };
}

describe('WithdrawalService.request with admin payout rules', () => {
  it('snapshots the cash figures and the destination on the request', async () => {
    const { svc, created, payoutConfig } = build();
    await svc.request('u1', 1000, 'IGNORED', 'key-1', 'CREATOR_EARNINGS', 'NG');
    expect(payoutConfig.requireQuote).toHaveBeenCalledWith('NG', 1000);
    expect(created[0]).toMatchObject({
      amountMinor: 1000, // coins
      currencyCode: 'NGN', // from the admin config, not the client's argument
      grossMinor: 50_000,
      feeMinor: 6_000, // 2% + flat
      netMinor: 44_000,
      rateMinorPer100Coins: 5000,
    });
    expect(created[0].payoutTo).toMatchObject({ bankName: 'GTBank', accountLast4: '1234', recipientCode: 'RCP_abc' });
  });

  it('refuses when there is no payout account, before reserving any coins', async () => {
    const { svc, wallet, tx } = build({ account: null });
    await expect(svc.request('u1', 1000, 'NGN', 'k', 'CREATOR_EARNINGS', 'NG')).rejects.toThrow('payout account');
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(tx.withdrawalRequest.create).not.toHaveBeenCalled();
  });

  it("refuses an amount outside the admin's limits, before reserving any coins", async () => {
    const { svc, wallet } = build();
    await expect(svc.request('u1', 500, 'NGN', 'k', 'CREATOR_EARNINGS', 'NG')).rejects.toThrow(/minimum withdrawal/);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('refuses when withdrawals are not enabled for the country', async () => {
    const { svc, wallet } = build({ quote: async () => { throw new BadRequestException('Withdrawals are not available in your country yet'); } });
    await expect(svc.request('u1', 1000, 'NGN', 'k', 'CREATOR_EARNINGS', 'GH')).rejects.toThrow(/not available in your country/);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('refuses when the balance is too low', async () => {
    const { svc, wallet } = build({ balance: 999n });
    await expect(svc.request('u1', 1000, 'NGN', 'k', 'CREATOR_EARNINGS', 'NG')).rejects.toThrow('Insufficient');
    expect(wallet.debit).not.toHaveBeenCalled();
  });
});

describe('identity verification gate', () => {
  const kycQuote = (requireKyc: boolean) => async (_c: string, coins: number) => ({ currencyCode: 'NGN', requireKyc, ...quoteWithdrawal(coins, RULES) });

  it('refuses an unverified person when the admin requires verification, before reserving any coins', async () => {
    const { svc, wallet } = build({ quote: kycQuote(true), verified: false });
    await expect(svc.request('u1', 1000, 'NGN', 'k', 'CREATOR_EARNINGS', 'NG')).rejects.toThrow('Verify your identity');
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('lets a verified person through', async () => {
    const { svc, created } = build({ quote: kycQuote(true), verified: true });
    await svc.request('u1', 1000, 'NGN', 'k', 'CREATOR_EARNINGS', 'NG');
    expect(created).toHaveLength(1);
  });

  it('does not ask for verification when the admin has turned the requirement off', async () => {
    const { svc, created } = build({ quote: kycQuote(false), verified: false });
    await svc.request('u1', 1000, 'NGN', 'k', 'CREATOR_EARNINGS', 'NG');
    expect(created).toHaveLength(1);
  });
});

describe('WithdrawalService.processPayout', () => {
  it('pays the NET cash figure to the saved recipient, not the coin count', async () => {
    const initiatePayout = jest.fn().mockResolvedValue({ providerRef: 'TRF_1' });
    const prisma: any = {
      withdrawalRequest: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'w1', creatorId: 'u1', walletType: 'CREATOR_EARNINGS', amountMinor: 1000, netMinor: 44_000, currencyCode: 'NGN', idempotencyKey: 'k', payoutTo: ACCOUNT }),
        update: jest.fn(async ({ data }: any) => data),
      },
    };
    const svc = new WithdrawalService(prisma, {} as any, {} as any, {} as any, { initiatePayout } as any, {} as any, {} as any, {} as any);
    await (svc as any).processPayout('w1');
    expect(initiatePayout).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 44_000, currencyCode: 'NGN', recipientCode: 'RCP_abc' }));
  });

  it('a withdrawal with no recorded cash amount fails safe: coins are released, nothing is sent', async () => {
    const initiatePayout = jest.fn();
    const credit = jest.fn();
    const tx = { withdrawalRequest: { update: jest.fn(async ({ data }: any) => data) } };
    const prisma: any = {
      withdrawalRequest: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'w1', creatorId: 'u1', walletType: 'CREATOR_EARNINGS', amountMinor: 1000, netMinor: null, currencyCode: 'NGN', idempotencyKey: 'k' }) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const svc = new WithdrawalService(prisma, { credit } as any, {} as any, {} as any, { initiatePayout } as any, { notifyOnce: jest.fn() } as any, {} as any, {} as any);
    await (svc as any).processPayout('w1');
    expect(initiatePayout).not.toHaveBeenCalled();
    expect(credit).toHaveBeenCalled(); // the reserve was released
    expect(tx.withdrawalRequest.update.mock.calls[0][0].data.status).toBe('FAILED');
  });
});
