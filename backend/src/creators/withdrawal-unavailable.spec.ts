import { ServiceUnavailableException } from '@nestjs/common';
import { WithdrawalService } from './withdrawal.service';
import { UnavailablePayoutProvider } from './providers/payout-provider.interface';

describe('WithdrawalService without a real payout provider', () => {
  it('refuses the request up front and touches neither the wallet nor the database', async () => {
    const prisma: any = { withdrawalRequest: { findUnique: jest.fn(), create: jest.fn() }, $transaction: jest.fn() };
    const wallet: any = { getBalance: jest.fn(), debit: jest.fn() };
    const svc = new WithdrawalService(prisma, wallet, {} as any, {} as any, new UnavailablePayoutProvider(), {} as any, {} as any, {} as any);

    await expect(svc.request('u1', 100, 'NGN', 'key-1')).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(wallet.debit).not.toHaveBeenCalled();
    expect(wallet.getBalance).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.withdrawalRequest.create).not.toHaveBeenCalled();
  });
});
