import { createHmac } from 'crypto';
import { WebhookRouterService } from './webhook-router.service';
import { PaymentWebhookController } from '../economy/payment-webhook.controller';
import { PayoutEventsRegistrar } from '../creators/payout-events.registrar';
import { PaystackPayoutProvider } from '../creators/providers/paystack-payout-provider';

describe('WebhookRouterService', () => {
  it('sends an event to the handler registered for its prefix, and reports whether one took it', async () => {
    const router = new WebhookRouterService();
    const handler = jest.fn();
    router.register('transfer.', handler);
    expect(await router.dispatch('transfer.success', { a: 1 })).toBe(true);
    expect(handler).toHaveBeenCalledWith({ a: 1 });
    expect(await router.dispatch('charge.success', {})).toBe(false);
    expect(await router.dispatch(undefined, {})).toBe(false);
  });

  it('lets a handler failure surface so the provider will retry', async () => {
    const router = new WebhookRouterService();
    router.register('transfer.', async () => { throw new Error('db down'); });
    await expect(router.dispatch('transfer.success', {})).rejects.toThrow('db down');
  });
});

describe('one Paystack URL for both payments and payouts', () => {
  const SECRET = 'sk_test';
  const paystackProvider = new PaystackPayoutProvider({ get: () => SECRET } as any);
  const signed = (payload: any) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    return { rawBody, headers: { 'x-paystack-signature': createHmac('sha512', SECRET).update(rawBody).digest('hex') } } as any;
  };

  const build = () => {
    const router = new WebhookRouterService();
    const withdrawals: any = { confirmPaid: jest.fn(), confirmFailed: jest.fn(), confirmReversed: jest.fn() };
    new PayoutEventsRegistrar(router, withdrawals, paystackProvider).onModuleInit();
    const coinPurchase: any = { confirm: jest.fn() };
    const paymentProvider: any = {
      verifyWebhookSignature: (raw: Buffer, h: any) => h['x-paystack-signature'] === createHmac('sha512', SECRET).update(raw).digest('hex'),
      handleWebhook: jest.fn(async () => ({ providerRef: 'ref', status: 'confirmed' })),
    };
    const ctl = new PaymentWebhookController(coinPurchase, {} as any, {} as any, paymentProvider, router);
    return { ctl, withdrawals, coinPurchase, paymentProvider };
  };

  it('a signed transfer.success on the payment URL settles the withdrawal and is NOT treated as a payment', async () => {
    const { ctl, withdrawals, coinPurchase, paymentProvider } = build();
    const payload = { event: 'transfer.success', data: { transfer_code: 'TRF_1' } };
    await ctl.handle(signed(payload), payload);
    expect(withdrawals.confirmPaid).toHaveBeenCalledWith('TRF_1');
    expect(paymentProvider.handleWebhook).not.toHaveBeenCalled();
    expect(coinPurchase.confirm).not.toHaveBeenCalled();
  });

  it('transfer.failed returns the coins via confirmFailed', async () => {
    const { ctl, withdrawals } = build();
    const payload = { event: 'transfer.failed', data: { transfer_code: 'TRF_2', reason: 'No such account' } };
    await ctl.handle(signed(payload), payload);
    expect(withdrawals.confirmFailed).toHaveBeenCalledWith('TRF_2', 'No such account');
    const reversed = { event: 'transfer.reversed', data: { transfer_code: 'TRF_3' } };
    await ctl.handle(signed(reversed), reversed);
    expect(withdrawals.confirmReversed).toHaveBeenCalledWith('TRF_3', 'The transfer was reversed');
  });

  it('payments still work on the same URL', async () => {
    const { ctl, coinPurchase, withdrawals } = build();
    const payload = { event: 'charge.success', data: { reference: 'ref' } };
    await ctl.handle(signed(payload), payload);
    expect(coinPurchase.confirm).toHaveBeenCalledWith('ref');
    expect(withdrawals.confirmPaid).not.toHaveBeenCalled();
  });

  it('an unsigned transfer event is rejected before anything is settled', async () => {
    const { ctl, withdrawals } = build();
    const payload = { event: 'transfer.success', data: { transfer_code: 'TRF_1' } };
    await expect(ctl.handle({ rawBody: Buffer.from(JSON.stringify(payload)), headers: { 'x-paystack-signature': 'forged' } } as any, payload)).rejects.toThrow('Invalid webhook signature');
    expect(withdrawals.confirmPaid).not.toHaveBeenCalled();
  });
});
