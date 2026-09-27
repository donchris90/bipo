import { PaymentWebhookController } from './payment-webhook.controller';

describe('PaymentWebhookController replay protection', () => {
  const rawBody = Buffer.from('{"event":"charge.success","data":{"reference":"coin_1"}}');
  const provider = {
    constructor: { name: 'PaystackPaymentProvider' },
    verifyWebhookSignature: jest.fn(() => true),
    handleWebhook: jest.fn(async () => ({ providerRef: 'coin_1', status: 'confirmed' as const })),
  };
  const coinPurchase = { confirm: jest.fn(async () => ({ id: 'purchase-1' })) };
  const chargeback = { record: jest.fn() };
  const router = { dispatch: jest.fn(async () => false) };

  it('acknowledges an identical verified replay without settling twice', async () => {
    const event = { id: 'event-1', status: 'PROCESSED' };
    const prisma: any = {
      paymentWebhookEvent: {
        findUnique: jest.fn(async () => event),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const controller = new PaymentWebhookController(coinPurchase as any, chargeback as any, prisma, provider as any, router as any);
    const req: any = { rawBody, headers: {}, user: undefined };
    const payload = { event: 'charge.success', data: { reference: 'coin_1' } };

    await expect(controller.handle(req, payload)).resolves.toEqual({ received: true });
    expect(coinPurchase.confirm).not.toHaveBeenCalled();
    expect(provider.handleWebhook).not.toHaveBeenCalled();
  });

  it('reprocesses a previously failed event', async () => {
    const event = { id: 'event-1', status: 'FAILED' };
    const prisma: any = {
      paymentWebhookEvent: {
        findUnique: jest.fn(async () => event),
        update: jest.fn(async (_args: any) => ({ ...event, status: 'PROCESSING' })),
        create: jest.fn(),
      },
    };
    const controller = new PaymentWebhookController(coinPurchase as any, chargeback as any, prisma, provider as any, router as any);
    const req: any = { rawBody, headers: {} };
    const payload = { event: 'charge.success', data: { reference: 'coin_1' } };

    await expect(controller.handle(req, payload)).resolves.toEqual({ received: true });
    expect(coinPurchase.confirm).toHaveBeenCalledWith('coin_1');
  });
});
