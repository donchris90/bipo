import { ForbiddenException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PayoutWebhookController } from './payout-webhook.controller';
import { MockPayoutProvider } from './providers/payout-provider.interface';
import { PaystackPayoutProvider, toPaystackReference } from './providers/paystack-payout-provider';

const SECRET = 'sk_test_secret';
const provider = new PaystackPayoutProvider({ get: () => SECRET } as any);
const sign = (raw: Buffer) => createHmac('sha512', SECRET).update(raw).digest('hex');
const req = (payload: any, signature?: string) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return { rawBody, headers: { 'x-paystack-signature': signature ?? sign(rawBody) } } as any;
};

describe('payout webhook', () => {
  const build = (p: any = provider) => {
    const withdrawals: any = { confirmPaid: jest.fn(), confirmFailed: jest.fn(), confirmReversed: jest.fn() };
    return { ctl: new PayoutWebhookController(withdrawals, p), withdrawals };
  };
  const success = { event: 'transfer.success', data: { transfer_code: 'TRF_1' } };

  it('rejects a request with a bad or missing signature, and changes nothing', async () => {
    const { ctl, withdrawals } = build();
    await expect(ctl.handle(req(success, 'deadbeef'), success)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.handle({ rawBody: Buffer.from('{}'), headers: {} } as any, success)).rejects.toBeInstanceOf(ForbiddenException);
    expect(withdrawals.confirmPaid).not.toHaveBeenCalled();
    expect(withdrawals.confirmFailed).not.toHaveBeenCalled();
  });

  it('marks a withdrawal paid on a signed transfer.success', async () => {
    const { ctl, withdrawals } = build();
    await ctl.handle(req(success), success);
    expect(withdrawals.confirmPaid).toHaveBeenCalledWith('TRF_1');
  });

  it('fails the withdrawal (returning the coins) on transfer.failed and transfer.reversed', async () => {
    const { ctl, withdrawals } = build();
    const failed = { event: 'transfer.failed', data: { transfer_code: 'TRF_2', reason: 'Account closed' } };
    await ctl.handle(req(failed), failed);
    expect(withdrawals.confirmFailed).toHaveBeenCalledWith('TRF_2', 'Account closed');
    const reversed = { event: 'transfer.reversed', data: { transfer_code: 'TRF_3' } };
    await ctl.handle(req(reversed), reversed);
    expect(withdrawals.confirmReversed).toHaveBeenCalledWith('TRF_3', 'The transfer was reversed');
  });

  it('ignores events that are not about payouts', async () => {
    const { ctl, withdrawals } = build();
    const other = { event: 'charge.success', data: { reference: 'x' } };
    await expect(ctl.handle(req(other), other)).resolves.toEqual({ received: true });
    expect(withdrawals.confirmPaid).not.toHaveBeenCalled();
  });

  it('a provider that cannot verify signatures (the mock) cannot receive webhooks at all', async () => {
    const { ctl, withdrawals } = build(new MockPayoutProvider());
    await expect(ctl.handle(req(success), success)).rejects.toBeInstanceOf(ForbiddenException);
    expect(withdrawals.confirmPaid).not.toHaveBeenCalled();
  });
});

describe('PaystackPayoutProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('normalises a reference to Paystack\'s 16-50 char lowercase format', () => {
    const ref = toPaystackReference('3F2504E0-4F89-11D3-9A0C-0305E82C3301');
    expect(ref).toMatch(/^[a-z0-9_-]{16,50}$/);
    expect(toPaystackReference('a').length).toBeGreaterThanOrEqual(16);
    expect(toPaystackReference('x'.repeat(200)).length).toBeLessThanOrEqual(50);
    expect(toPaystackReference('x'.repeat(200))).not.toBe(toPaystackReference('x'.repeat(199) + 'y'));
  });

  it('sends the net amount to the recipient and returns the transfer code', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: true, data: { status: 'pending', transfer_code: 'TRF_9' } }) });
    global.fetch = fetchMock as any;
    const out = await provider.initiatePayout({ userId: 'u', amountMinor: 44_000, currencyCode: 'NGN', idempotencyKey: 'abc-123', recipientCode: 'RCP_abc' });
    expect(out.providerRef).toBe('TRF_9');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ source: 'balance', amount: 44_000, currency: 'NGN', recipient: 'RCP_abc' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('treats an OTP-gated transfer, a rejection, or a missing recipient as a failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: true, data: { status: 'otp', transfer_code: 'T' } }) }) as any;
    await expect(provider.initiatePayout({ userId: 'u', amountMinor: 1, currencyCode: 'NGN', idempotencyKey: 'k', recipientCode: 'R' })).rejects.toThrow(/OTP/);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ status: false, message: 'Insufficient balance' }) }) as any;
    await expect(provider.initiatePayout({ userId: 'u', amountMinor: 1, currencyCode: 'NGN', idempotencyKey: 'k', recipientCode: 'R' })).rejects.toThrow(/Insufficient balance/);
    await expect(provider.initiatePayout({ userId: 'u', amountMinor: 1, currencyCode: 'NGN', idempotencyKey: 'k' })).rejects.toThrow(/recipient/);
  });
});
