import { BadRequestException } from '@nestjs/common';
import { ChargebackService } from './chargeback.service';

function harness(status = 'CONFIRMED') {
  const purchase = {
    id: 'buy1', userId: 'u1', amountMinor: 500000, currencyCode: 'NGN', coinAmount: 1000, status,
  };
  const txChargeback = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(async ({ data }: any) => ({ id: 'cb1', ...data })) };
  const txPurchase = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
  const prisma: any = {
    chargeback: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn() },
    coinPurchase: { findUnique: jest.fn().mockResolvedValue(purchase) },
    $transaction: jest.fn(async (fn: any) => fn({ coinPurchase: txPurchase, chargeback: txChargeback })),
  };
  const wallet: any = { forceDebit: jest.fn().mockResolvedValue({}) };
  return { svc: new ChargebackService(prisma, wallet), prisma, wallet, txPurchase, txChargeback };
}

describe('ChargebackService', () => {
  it('refuses to claw back a purchase that never confirmed', async () => {
    const { svc, wallet } = harness('PENDING');
    await expect(svc.record('buy1', 'dispute')).rejects.toBeInstanceOf(BadRequestException);
    expect(wallet.forceDebit).not.toHaveBeenCalled();
  });

  it('uses the purchase id as the stable clawback idempotency key', async () => {
    const { svc, wallet } = harness();
    await svc.record('buy1', 'dispute', 'provider-event-1');
    expect(wallet.forceDebit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'chargeback:buy1', amount: 1000n }),
      expect.anything(),
    );
  });

  it('does not touch the wallet when the atomic purchase claim loses the race', async () => {
    const { svc, wallet, txPurchase, txChargeback } = harness();
    txPurchase.updateMany.mockResolvedValueOnce({ count: 0 });
    txChargeback.findUnique.mockResolvedValueOnce(null);
    await expect(svc.record('buy1', 'dispute')).rejects.toBeInstanceOf(BadRequestException);
    expect(wallet.forceDebit).not.toHaveBeenCalled();
  });
});
