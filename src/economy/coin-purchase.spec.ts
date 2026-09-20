import { NotFoundException } from '@nestjs/common';
import { CoinPurchaseController } from './economy.controller';
import { CoinPurchaseService } from './coin-purchase.service';
import { MockPaymentProvider, UnavailablePaymentProvider } from './providers/payment-provider.interface';

class PaystackPaymentProvider {
  async createPayment() { return { providerRef: 'ref_1', redirectUrl: 'https://checkout.paystack.com/abc' }; }
}

function build(provider: any, existing: any = null) {
  const created: any[] = [];
  const prisma: any = {
    coinPackage: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', active: true, priceMinor: 500000, currencyCode: 'NGN', coinAmount: 1000 }) },
    coinPurchase: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn(async ({ data }: any) => { created.push(data); return { id: 'buy1', ...data }; }),
    },
  };
  return { svc: new CoinPurchaseService(prisma, {} as any, provider, {} as any), prisma, created };
}

describe('CoinPurchaseService.initiate', () => {
  it("keeps the provider's payment page URL so the app can send the person to pay", async () => {
    const { svc, created } = build(new PaystackPaymentProvider());
    const purchase: any = await svc.initiate('u1', 'p1', 'key-1');
    expect(purchase.checkoutUrl).toBe('https://checkout.paystack.com/abc');
    expect(created[0]).toMatchObject({ provider: 'paystack', status: 'PENDING', coinAmount: 1000, amountMinor: 500000 });
  });

  it('a retry with the same key returns the original purchase (and its link) without charging twice', async () => {
    const existing = { id: 'buy1', checkoutUrl: 'https://checkout.paystack.com/abc', status: 'PENDING' };
    const { svc, prisma } = build(new PaystackPaymentProvider(), existing);
    expect(await svc.initiate('u1', 'p1', 'key-1')).toBe(existing);
    expect(prisma.coinPurchase.create).not.toHaveBeenCalled();
  });
});

describe('CoinPurchaseService.statusFor', () => {
  const svc = (row: any) => new CoinPurchaseService({ coinPurchase: { findUnique: jest.fn().mockResolvedValue(row) } } as any, {} as any, {} as any, {} as any);

  it('reports the status of your own purchase', async () => {
    const out = await svc({ id: 'b', userId: 'u1', status: 'CONFIRMED', coinAmount: 1000, confirmedAt: new Date(0) }).statusFor('u1', 'b');
    expect(out).toMatchObject({ status: 'CONFIRMED', coinAmount: 1000 });
  });

  it("never reveals someone else's purchase", async () => {
    await expect(svc({ id: 'b', userId: 'someone-else', status: 'CONFIRMED', coinAmount: 1, confirmedAt: null }).statusFor('u1', 'b')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc(null).statusFor('u1', 'b')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('payment methods', () => {
  const methods = (provider: any) => new CoinPurchaseController({} as any, {} as any, provider).paymentMethods();

  it('lists Stripe as coming soon and never available', () => {
    const stripe = methods(new PaystackPaymentProvider()).find((m: any) => m.id === 'STRIPE')!;
    expect(stripe).toMatchObject({ available: false, comingSoon: true });
  });

  it('Paystack is available when a provider is configured, and not when payments are unavailable', () => {
    expect(methods(new MockPaymentProvider()).find((m: any) => m.id === 'PAYSTACK')!.available).toBe(true);
    expect(methods(new UnavailablePaymentProvider()).find((m: any) => m.id === 'PAYSTACK')!.available).toBe(false);
  });
});
