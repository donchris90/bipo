import { NotFoundException } from '@nestjs/common';
import { CoinPurchaseController } from './economy.controller';
import { CoinPurchaseService } from './coin-purchase.service';
import { MockPaymentProvider, UnavailablePaymentProvider } from './providers/payment-provider.interface';

// (initiating a purchase is covered end to end in payments-acceptance.spec.ts)

describe('CoinPurchaseService.statusFor', () => {
  const svc = (row: any) => new CoinPurchaseService({ coinPurchase: { findUnique: jest.fn().mockResolvedValue(row), findUniqueOrThrow: jest.fn().mockResolvedValue(row) } } as any, {} as any, {} as any, {} as any);

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
  const ALL = { paymentMethods: ['PAYSTACK', 'CRYPTO', 'C2C'] };
  const methods = async (provider: any, country = 'NG', region: any = ALL) => {
    const prisma: any = { regionalConfig: { findUnique: jest.fn().mockResolvedValue(region) } };
    const list: any[] = await new CoinPurchaseController({} as any, prisma, provider).paymentMethods({ user: { countryCode: country } } as any);
    return (id: string) => list.find((m) => m.id === id)!;
  };

  it('Paystack is available in Nigeria when the country enables it and a real provider is configured', async () => {
    expect((await methods(new MockPaymentProvider()))('PAYSTACK').available).toBe(true);
  });

  it('Paystack is not available when payments are unavailable, in another country, or when the country has not enabled it', async () => {
    expect((await methods(new UnavailablePaymentProvider()))('PAYSTACK').available).toBe(false);
    expect((await methods(new MockPaymentProvider(), 'GH'))('PAYSTACK').available).toBe(false);
    expect((await methods(new MockPaymentProvider(), 'NG', { paymentMethods: ['C2C'] }))('PAYSTACK').available).toBe(false);
    expect((await methods(new MockPaymentProvider(), 'NG', null))('PAYSTACK').available).toBe(false);
  });

  it('Crypto and C2C are never offered as working unless a real provider is connected', async () => {
    const m = await methods(new MockPaymentProvider());
    expect(m('CRYPTO')).toMatchObject({ available: false, comingSoon: true });
    expect(m('C2C').available).toBe(false); // there is no automatic payment verification to make it safe
  });
});
