import { createHmac } from 'crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WalletType } from '@prisma/client';
import { FakePrisma } from '../test-utils/fake-prisma';
import { WalletService } from './wallet.service';
import { CoinPurchaseService } from './coin-purchase.service';
import { ChargebackService } from './chargeback.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { CoinPurchaseController } from './economy.controller';
import { PaystackPaymentProvider, toPaystackPaymentReference } from './providers/paystack-payment-provider';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';

// Phase 4 acceptance tests: the whole payment path, from starting a purchase to a
// webhook to the coins landing (or not) in the wallet, using the REAL purchase service,
// wallet, chargeback service, webhook controller and Paystack adapter. Only the things
// outside this program are faked: the database (in memory) and Paystack's servers (a
// scripted fetch). So these prove the RULES the code enforces; they cannot prove that
// Paystack itself behaves as scripted here — that needs the live test in the checklist.

const SECRET = 'sk_test_secret';
const PKG = { id: 'pkg1', active: true, countryCode: 'NG', priceMinor: 500000, currencyCode: 'NGN', coinAmount: 1000 };
const KEY = 'purchase-key-0000000001';

function world(over: { region?: any; pkg?: any } = {}) {
  const fake: any = new FakePrisma();
  const purchases = new Map<string, any>();
  const chargebacks = new Map<string, any>();
  let seq = 0;
  fake.users.set('u1', { id: 'u1', email: 'ada@example.com', countryCode: 'NG' });
  fake.users.set('u2', { id: 'u2', email: 'bo@example.com', countryCode: 'NG' });
  fake.user.findUniqueOrThrow = async ({ where: { id } }: any) => fake.users.get(id);
  fake.coinPackage = { findUnique: async ({ where: { id } }: any) => (id === 'pkg1' ? { ...PKG, ...(over.pkg ?? {}) } : null) };
  fake.regionalConfig = { findUnique: async ({ where: { countryCode } }: any) => (countryCode === 'NG' ? (over.region ?? { active: true, paymentsEnabled: true, paymentMethods: ['PAYSTACK'] }) : { active: true, paymentsEnabled: true, paymentMethods: ['PAYSTACK'] }) };
  const match = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
  fake.coinPurchase = {
    findUnique: async ({ where }: any) => [...purchases.values()].find((p) => match(p, where)) ?? null,
    findFirst: async ({ where }: any) => [...purchases.values()].find((p) => match(p, where)) ?? null,
    findUniqueOrThrow: async ({ where }: any) => [...purchases.values()].find((p) => match(p, where))!,
    create: async ({ data }: any) => { const row = { id: `buy${++seq}`, createdAt: new Date(), confirmedAt: null, ...data }; purchases.set(row.id, row); return row; },
    update: async ({ where, data }: any) => Object.assign(purchases.get(where.id), data),
    updateMany: async ({ where, data }: any) => {
      const rows = [...purchases.values()].filter((p) => match(p, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  };
  fake.chargeback = {
    findUnique: async ({ where: { coinPurchaseId } }: any) => chargebacks.get(coinPurchaseId) ?? null,
    create: async ({ data }: any) => { if (chargebacks.has(data.coinPurchaseId)) throw new Error('Unique constraint failed on coinPurchaseId'); chargebacks.set(data.coinPurchaseId, data); return data; },
    count: async () => chargebacks.size,
  };

  // Paystack, scripted. `paystack.tx[ref]` is what Paystack would answer to /transaction/verify.
  const paystack: { tx: Record<string, any>; initCalls: any[]; verifyCalls: string[]; initFails: boolean } = { tx: {}, initCalls: [], verifyCalls: [], initFails: false };
  jest.spyOn(global, 'fetch').mockImplementation((async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/transaction/initialize')) {
      const body = JSON.parse(init.body);
      paystack.initCalls.push({ body, auth: init.headers.Authorization });
      if (paystack.initFails) return { ok: false, json: async () => ({ status: false, message: 'Invalid key' }) };
      paystack.tx[body.reference] = { status: 'abandoned', amount: body.amount, currency: body.currency };
      return { ok: true, json: async () => ({ status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, reference: body.reference } }) };
    }
    if (u.includes('/transaction/verify/')) {
      const ref = decodeURIComponent(u.split('/transaction/verify/')[1]);
      paystack.verifyCalls.push(ref);
      const t = paystack.tx[ref];
      return t ? { ok: true, json: async () => ({ status: true, data: t }) } : { ok: false, json: async () => ({ status: false, message: 'Transaction reference not found' }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as any);

  const config: any = { get: (k: string) => (k === 'PAYSTACK_SECRET_KEY' ? SECRET : undefined) };
  const provider = new PaystackPaymentProvider(config, fake);
  const wallet = new WalletService(fake);
  const notifications: any = { notifyOnce: jest.fn() };
  const service = new CoinPurchaseService(fake, wallet, provider, notifications);
  const chargeback = new ChargebackService(fake, wallet);
  const controller = new PaymentWebhookController(service, chargeback, fake, provider, { dispatch: async () => false } as any);

  // A webhook as Paystack would send it: the exact bytes, signed with the secret.
  const webhook = (payload: any, opts: { sign?: boolean | string; raw?: boolean } = {}) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = opts.sign === false ? undefined : typeof opts.sign === 'string' ? opts.sign : createHmac('sha512', SECRET).update(rawBody).digest('hex');
    const req: any = { rawBody: opts.raw === false ? undefined : rawBody, headers: sig ? { 'x-paystack-signature': sig } : {} };
    return controller.handle(req, payload);
  };
  const balance = (u = 'u1') => wallet.getBalance(u, WalletType.COIN);
  const start = async (userId = 'u1', key = KEY) => (await service.initiate(userId, 'pkg1', key, 'PAYSTACK')) as any;
  const ledgerFor = (type: string) => [...fake.ledger.values()].filter((l: any) => l.type === type);
  const paidOnPaystack = (ref: string) => { paystack.tx[ref] = { ...paystack.tx[ref], status: 'success' }; };
  return { fake, service, controller, chargeback, wallet, paystack, purchases, chargebacks, webhook, balance, start, ledgerFor, paidOnPaystack, notifications, provider };
}
afterEach(() => jest.restoreAllMocks());

describe('Phase 4 — starting a purchase', () => {
  it('asks Paystack to start the payment for the right amount, currency, customer and a stable reference, and credits NOTHING yet', async () => {
    const w = world();
    const p = await w.start();
    expect(w.paystack.initCalls).toHaveLength(1);
    expect(w.paystack.initCalls[0].body).toEqual({ email: 'ada@example.com', amount: 500000, currency: 'NGN', reference: toPaystackPaymentReference(KEY) });
    expect(w.paystack.initCalls[0].auth).toBe(`Bearer ${SECRET}`);
    expect(p).toMatchObject({ status: 'PENDING', coinAmount: 1000, amountMinor: 500000, provider: 'paystack', checkoutUrl: `https://checkout.paystack.com/${toPaystackPaymentReference(KEY)}` });
    expect(await w.balance()).toBe(0n);
  });

  it('if Paystack refuses to start it, no purchase is recorded and no coins move', async () => {
    const w = world();
    w.paystack.initFails = true;
    await expect(w.start()).rejects.toThrow(/Paystack transaction initialization failed/);
    expect(w.purchases.size).toBe(0);
    expect(await w.balance()).toBe(0n);
  });

  it('a retry with the same key returns the original purchase and does not call Paystack again', async () => {
    const w = world();
    const first = await w.start();
    const again = await w.start();
    expect(again.id).toBe(first.id);
    expect(w.paystack.initCalls).toHaveLength(1);
    expect(w.purchases.size).toBe(1);
  });

  it('refuses: a package from another country, an inactive package, an unknown package, a country without the method, Paystack outside Nigeria, and weak idempotency keys', async () => {
    await expect(world({ pkg: { countryCode: 'GH' } }).start()).rejects.toThrow(/not available in your country/);
    await expect(world({ pkg: { active: false } }).start()).rejects.toThrow(/not available/);
    const w = world();
    await expect(w.service.initiate('u1', 'nope', KEY, 'PAYSTACK')).rejects.toThrow(/not available/);
    await expect(world({ region: { active: true, paymentsEnabled: true, paymentMethods: ['C2C'] } }).start()).rejects.toThrow(/payment method is not available/);
    await expect(world({ region: { active: true, paymentsEnabled: false, paymentMethods: ['PAYSTACK'] } }).start()).rejects.toThrow(/payment method is not available/);
    for (const key of ['short', 'has spaces in it 123456', 'x'.repeat(129)]) await expect(w.service.initiate('u1', 'pkg1', key, 'PAYSTACK')).rejects.toThrow(/Invalid idempotency key/);
    w.fake.users.set('u3', { id: 'u3', email: 'gh@example.com', countryCode: 'GH' });
    await expect(w.service.initiate('u3', 'pkg1', 'ghana-purchase-key-01', 'PAYSTACK')).rejects.toThrow(/(not available in your country|only available in Nigeria)/);
  });
});

describe('Phase 4 — coins are never credited by the client', () => {
  it('the customer-facing purchase routes offer no way to confirm or mark a payment as paid', () => {
    const proto: any = CoinPurchaseController.prototype;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((n) => n !== 'constructor')
      .map((n) => ({ name: n, method: Reflect.getMetadata(METHOD_METADATA, proto[n]), path: Reflect.getMetadata(PATH_METADATA, proto[n]) }))
      .filter((r) => r.method !== undefined);
    for (const r of routes) expect(String(r.path)).not.toMatch(/confirm|verify|paid|success|complete/i);
    expect(routes.filter((r) => r.method === 1 /* POST */).length).toBeLessThanOrEqual(1); // only "start a purchase"
    // and the only writer of the wallet in this flow, confirm(), is reachable from the webhook, never from these routes
    expect(routes.some((r) => r.name === 'confirm')).toBe(false);
  });

  it('polling a purchase never credits by itself: while Paystack says the customer has not paid, the balance is unchanged', async () => {
    const w = world();
    const p = await w.start();
    p.createdAt = new Date(Date.now() - 60_000); // old enough to be re-checked with Paystack
    await w.service.statusFor('u1', p.id);
    expect(await w.balance()).toBe(0n);
  });

  // Paystack reports a payment that was started but not yet finished as "abandoned" — that is
  // the state EVERY new payment is in until the customer pays. The service treats it as final
  // and marks the purchase FAILED 10 seconds in, while the customer may still be on the payment
  // page (the app then shows a failure, and they may pay a second time). No money is lost — a
  // later success webhook still credits — but the status is wrong.
  it.failing('DEFECT: a payment the customer has not finished yet is not declared FAILED', async () => {
    const w = world();
    const p = await w.start();
    p.createdAt = new Date(Date.now() - 60_000);
    const s: any = await w.service.statusFor('u1', p.id);
    expect(s.status).toBe('PENDING');
  });

  it('...and if that customer then pays, the success still credits (nothing is lost by the early FAILED)', async () => {
    const w = world();
    const p = await w.start();
    p.createdAt = new Date(Date.now() - 60_000);
    await w.service.statusFor('u1', p.id); // marked FAILED while unpaid
    w.paidOnPaystack(p.providerRef);
    await w.webhook({ event: 'charge.success', data: { reference: p.providerRef } });
    expect(await w.balance()).toBe(1000n);
    expect((w.purchases.get(p.id) as any).status).toBe('CONFIRMED');
  });

  it("nobody can read another person's purchase", async () => {
    const w = world();
    const p = await w.start();
    await expect(w.service.statusFor('u2', p.id)).rejects.toThrow(/Purchase not found/);
  });
});

describe('Phase 4 — webhooks: signatures', () => {
  it('a webhook with a missing, wrong or truncated signature is refused before anything is read, and nothing is credited', async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    const payload = { event: 'charge.success', data: { reference: p.providerRef } };
    await expect(w.webhook(payload, { sign: false })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.webhook(payload, { sign: 'a'.repeat(128) })).rejects.toThrow(/Invalid webhook signature/);
    await expect(w.webhook(payload, { sign: 'abc' })).rejects.toThrow(/Invalid webhook signature/);
    await expect(w.webhook(payload, { raw: false })).rejects.toThrow(/Raw request body unavailable/);
    expect(w.paystack.verifyCalls).toEqual([]); // not even Paystack is asked
    expect(await w.balance()).toBe(0n);
    expect((w.purchases.get(p.id) as any).status).toBe('PENDING');
  });

  it('a signature made with a different secret is refused, and so is a valid signature over DIFFERENT bytes (tampered body)', async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    const payload = { event: 'charge.success', data: { reference: p.providerRef } };
    const wrongSecret = createHmac('sha512', 'not-the-secret').update(Buffer.from(JSON.stringify(payload))).digest('hex');
    await expect(w.webhook(payload, { sign: wrongSecret })).rejects.toThrow(/Invalid webhook signature/);
    const signedOriginal = createHmac('sha512', SECRET).update(Buffer.from(JSON.stringify(payload))).digest('hex');
    const tampered = { event: 'charge.success', data: { reference: p.providerRef, extra: 'changed' } };
    await expect(w.webhook(tampered, { sign: signedOriginal })).rejects.toThrow(/Invalid webhook signature/);
    expect(await w.balance()).toBe(0n);
  });
});

describe('Phase 4 — a successful payment', () => {
  it('a signed charge.success is re-checked with Paystack, then credits exactly the package coins once, marks the purchase CONFIRMED and notifies once', async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    await w.webhook({ event: 'charge.success', data: { reference: p.providerRef } });
    expect(w.paystack.verifyCalls).toEqual([p.providerRef]); // server-side verification happened
    expect(await w.balance()).toBe(1000n);
    expect((w.purchases.get(p.id) as any)).toMatchObject({ status: 'CONFIRMED' });
    expect(w.ledgerFor('COIN_PURCHASE')).toHaveLength(1);
    expect(w.notifications.notifyOnce).toHaveBeenCalledTimes(1);
  });

  it('the webhook cannot be used to claim a payment Paystack does not confirm (webhook says success, Paystack says abandoned)', async () => {
    const w = world();
    const p = await w.start(); // Paystack's record: abandoned
    await expect(w.webhook({ event: 'charge.success', data: { reference: p.providerRef } })).rejects.toThrow(/not yet verified/);
    expect(await w.balance()).toBe(0n);
  });

  it('DUPLICATE deliveries (one after the other) credit once', async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    const event = { event: 'charge.success', data: { reference: p.providerRef } };
    await w.webhook(event);
    await w.webhook(event);
    await w.webhook(event);
    expect(await w.balance()).toBe(1000n);
    expect(w.ledgerFor('COIN_PURCHASE')).toHaveLength(1);
    expect(w.notifications.notifyOnce).toHaveBeenCalledTimes(1);
  });

  it('DUPLICATE deliveries arriving AT THE SAME TIME credit once', async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    const event = { event: 'charge.success', data: { reference: p.providerRef } };
    await Promise.all([w.webhook(event), w.webhook(event), w.webhook(event)]);
    expect(await w.balance()).toBe(1000n);
    expect(w.ledgerFor('COIN_PURCHASE')).toHaveLength(1);
  });

  it('a webhook for a reference we never issued is refused and credits nothing', async () => {
    const w = world();
    w.paystack.tx['coin_unknown'] = { status: 'success', amount: 500000, currency: 'NGN' };
    await expect(w.webhook({ event: 'charge.success', data: { reference: 'coin_unknown' } })).rejects.toThrow(/Purchase not found/);
    expect(await w.balance()).toBe(0n);
  });

  it('the polling path can recover a lost webhook: after the grace period the server asks Paystack, and credits once if it is paid', async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    p.createdAt = new Date(Date.now() - 60_000);
    const s: any = await w.service.statusFor('u1', p.id);
    expect(s.status).toBe('CONFIRMED');
    await w.service.statusFor('u1', p.id);
    expect(await w.balance()).toBe(1000n);
    expect(w.ledgerFor('COIN_PURCHASE')).toHaveLength(1);
  });
});

describe('Phase 4 — pending, failed, cancelled and mismatched payments', () => {
  it('PENDING: not paid yet leaves the purchase pending with no credit; the later success then credits once', async () => {
    const w = world();
    const p = await w.start();
    w.paystack.tx[p.providerRef].status = 'ongoing';
    await expect(w.webhook({ event: 'charge.success', data: { reference: p.providerRef } })).rejects.toBeInstanceOf(BadRequestException);
    expect((w.purchases.get(p.id) as any).status).toBe('PENDING');
    expect(await w.balance()).toBe(0n);
    w.paidOnPaystack(p.providerRef);
    await w.webhook({ event: 'charge.success', data: { reference: p.providerRef } });
    expect(await w.balance()).toBe(1000n);
  });

  it.each(['failed', 'abandoned', 'cancelled', 'reversed'])('%s on Paystack marks the purchase FAILED and credits nothing', async (status) => {
    const w = world();
    const p = await w.start();
    w.paystack.tx[p.providerRef].status = status;
    await expect(w.webhook({ event: 'charge.success', data: { reference: p.providerRef } })).rejects.toThrow(/not yet verified/);
    expect((w.purchases.get(p.id) as any).status).toBe(status === 'abandoned' || status === 'failed' || status === 'cancelled' || status === 'reversed' ? 'FAILED' : 'PENDING');
    expect(await w.balance()).toBe(0n);
  });

  it('a charge.failed event fails a pending purchase and never touches the wallet', async () => {
    const w = world();
    const p = await w.start();
    await w.webhook({ event: 'charge.failed', data: { reference: p.providerRef } });
    expect((w.purchases.get(p.id) as any).status).toBe('FAILED');
    expect(await w.balance()).toBe(0n);
  });

  it('a charge.failed event can NOT undo a purchase that was already confirmed and credited', async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    await w.webhook({ event: 'charge.success', data: { reference: p.providerRef } });
    await w.webhook({ event: 'charge.failed', data: { reference: p.providerRef } });
    expect((w.purchases.get(p.id) as any).status).toBe('CONFIRMED');
    expect(await w.balance()).toBe(1000n);
  });

  it('AMOUNT mismatch: a real payment for less than the package price is refused, marked FAILED and credits nothing', async () => {
    const w = world();
    const p = await w.start();
    w.paystack.tx[p.providerRef] = { status: 'success', amount: 50000, currency: 'NGN' }; // paid 500 not 5000
    await expect(w.webhook({ event: 'charge.success', data: { reference: p.providerRef } })).rejects.toThrow(/amount or currency does not match/);
    expect((w.purchases.get(p.id) as any).status).toBe('FAILED');
    expect(await w.balance()).toBe(0n);
  });

  it('CURRENCY mismatch: the right number in another currency is refused', async () => {
    const w = world();
    const p = await w.start();
    w.paystack.tx[p.providerRef] = { status: 'success', amount: 500000, currency: 'GHS' };
    await expect(w.webhook({ event: 'charge.success', data: { reference: p.providerRef } })).rejects.toThrow(/amount or currency does not match/);
    expect(await w.balance()).toBe(0n);
  });

  it('events that are not about purchases are ignored safely', async () => {
    const w = world();
    const p = await w.start();
    expect(await w.webhook({ event: 'customeridentification.success', data: { reference: p.providerRef } })).toEqual({ received: true });
    expect((w.purchases.get(p.id) as any).status).toBe('PENDING');
  });
});

describe('Phase 4 — chargebacks and refunds', () => {
  const confirmed = async () => {
    const w = world();
    const p = await w.start();
    w.paidOnPaystack(p.providerRef);
    await w.webhook({ event: 'charge.success', data: { reference: p.providerRef } });
    return { w, p };
  };

  it('a dispute claws back exactly the purchased coins, once, and marks the purchase CHARGEBACK', async () => {
    const { w, p } = await confirmed();
    await w.webhook({ event: 'charge.dispute.create', data: { reference: p.providerRef, reason: 'fraud' } });
    expect(await w.balance()).toBe(0n);
    expect((w.purchases.get(p.id) as any).status).toBe('CHARGEBACK');
    expect(w.chargebacks.size).toBe(1);
    expect(w.ledgerFor('CHARGEBACK')).toHaveLength(1);
  });

  it('the same dispute delivered again does not claw back twice', async () => {
    const { w, p } = await confirmed();
    const dispute = { event: 'charge.dispute.create', data: { reference: p.providerRef } };
    await w.webhook(dispute);
    await w.webhook(dispute);
    await w.webhook(dispute);
    expect(w.chargebacks.size).toBe(1);
    expect(w.ledgerFor('CHARGEBACK')).toHaveLength(1);
    expect(await w.balance()).toBe(0n);
  });

  // (In this in-memory test one of two simultaneous deliveries may be rejected, because the
  // fake database has no row locking; the real database makes the second wait and return the
  // first's result. What matters, and is checked, is that the coins are taken back only once.)
  it('two simultaneous deliveries of the same dispute still claw back once', async () => {
    const { w, p } = await confirmed();
    const dispute = { event: 'charge.dispute.create', data: { reference: p.providerRef } };
    await Promise.allSettled([w.webhook(dispute), w.webhook(dispute)]);
    expect(w.chargebacks.size).toBe(1);
    expect(w.ledgerFor('CHARGEBACK')).toHaveLength(1);
    expect(await w.balance()).toBe(0n);
  });

  it('if the person already spent the coins, the clawback leaves a negative balance (a debt) rather than failing or forgiving it', async () => {
    const { w, p } = await confirmed();
    await w.wallet.debit({ userId: 'u1', walletType: WalletType.COIN, amount: 900n, ledgerType: 'GIFT_SENT' as any, reference: 'spent', idempotencyKey: 'spent-1' });
    await w.webhook({ event: 'charge.dispute.create', data: { reference: p.providerRef } });
    expect(await w.balance()).toBe(-900n);
  });

  it('a chargeback against a purchase that never credited coins is refused (no negative balance from nothing)', async () => {
    const w = world();
    const p = await w.start();
    await expect(w.chargeback.record(p.id, 'x')).rejects.toThrow(/Only a confirmed coin purchase/);
    expect(await w.balance()).toBe(0n);
  });

  // Documented in UPDATE-V7 as done; the code does not do it. These two tests describe what
  // the note promises, and are expected to FAIL until it is implemented.
  it.failing('DEFECT: a Paystack refund.processed event claws the coins back (UPDATE-V7 says it does; the Paystack adapter ignores the event)', async () => {
    const { w, p } = await confirmed();
    await w.webhook({ event: 'refund.processed', data: { transaction_reference: p.providerRef, reference: p.providerRef } });
    expect(await w.balance()).toBe(0n);
  });
});

describe('Phase 4 — security findings', () => {
  it.failing("DEFECT: reusing SOMEONE ELSE'S idempotency key returns their purchase (and payment link) instead of being refused", async () => {
    const w = world();
    await w.start('u1', KEY);
    await expect(w.start('u2', KEY)).rejects.toBeDefined();
  });
});
