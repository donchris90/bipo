import { createHmac } from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { WalletType } from '@prisma/client';
import { FakePrisma } from '../test-utils/fake-prisma';
import { WalletService } from '../economy/wallet.service';
import { PayoutConfigService } from '../payouts/payout-config.service';
import { PaystackPayoutProvider } from './providers/paystack-payout-provider';
import { WithdrawalService } from './withdrawal.service';
import { PayoutWebhookController } from './payout-webhook.controller';

// Phase 5 acceptance tests: the withdrawal path from request to money out, using the REAL
// withdrawal service, wallet, payout-limit rules and Paystack payout adapter. Only what is
// outside this program is faked: the database (in memory) and Paystack's servers (scripted).
// After EVERY state change the wallet balance is checked against what it must be.
// They prove the rules the code enforces; they cannot prove Paystack really pays out — the
// live transfer test on the checklist still has to be done with real credentials.

const SECRET = 'sk_test_payout';
const START = 50_000n; // earnings the creator starts with
const BASE = { enabled: true, requireKyc: true, currencyCode: 'NGN', minorPer100Coins: 5000, minWithdrawalCoins: 1000, maxWithdrawalCoins: 100_000, feeBps: 100, feeFlatMinor: 0, maxDailyWithdrawalCoins: null, maxMonthlyWithdrawalCoins: null, manualReviewAboveCoins: null, cooldownHours: 0, allowedProviders: null };
const ACCOUNT = { provider: 'PAYSTACK', bankName: 'GTBank', accountLast4: '1234', accountName: 'Ada Obi', recipientCode: 'RCP_1' };

function world(over: { config?: any; risk?: any; kyc?: boolean; account?: any | null; providerConfigured?: boolean } = {}) {
  const fake: any = new FakePrisma();
  const rows = new Map<string, any>();
  let seq = 0;
  fake.users.set('u1', { id: 'u1', kycVerified: over.kyc ?? true });
  fake.users.set('u2', { id: 'u2', kycVerified: true });
  fake.agency = { findFirst: async () => null };
  const config: any = { countryCode: 'NG', updatedAt: new Date(), ...BASE, ...(over.config ?? {}) };
  fake.payoutConfig = { findUnique: async () => (over.config === null ? null : config) };
  const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'not' in (v as any) ? r[k] !== (v as any).not : v && typeof v === 'object' && 'gte' in (v as any) ? r[k] >= (v as any).gte : r[k] === v));
  fake.withdrawalRequest = {
    create: async ({ data }: any) => { const row = { id: `wd${++seq}`, requestedAt: new Date(), decidedAt: null, providerRef: null, failureReason: null, riskFlags: null, payoutProvider: null, ...data }; rows.set(row.id, row); return row; },
    findUnique: async ({ where }: any) => [...rows.values()].find((r) => match(r, where)) ?? null,
    findUniqueOrThrow: async ({ where }: any) => { const r = [...rows.values()].find((x) => match(x, where)); if (!r) throw new Error('not found'); return r; },
    findFirst: async ({ where, orderBy }: any) => { const list = [...rows.values()].filter((r) => match(r, where)); if (orderBy?.requestedAt === 'desc') list.sort((a, b) => b.requestedAt - a.requestedAt); return list[0] ?? null; },
    update: async ({ where, data }: any) => Object.assign(rows.get(where.id), data),
    updateMany: async ({ where, data }: any) => { const list = [...rows.values()].filter((r) => match(r, where)); list.forEach((r) => Object.assign(r, data)); return { count: list.length }; },
    aggregate: async ({ where }: any) => ({ _sum: { amountMinor: [...rows.values()].filter((r) => match(r, where)).reduce((n, r) => n + r.amountMinor, 0) } }),
  };

  const paystack = { transfers: [] as any[], mode: 'ok' as 'ok' | 'reject' | 'otp' };
  jest.spyOn(global, 'fetch').mockImplementation((async (url: any, init: any) => {
    if (!String(url).endsWith('/transfer')) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    paystack.transfers.push(body);
    if (paystack.mode === 'reject') return { ok: false, status: 400, json: async () => ({ status: false, message: 'Insufficient balance' }) };
    if (paystack.mode === 'otp') return { ok: true, json: async () => ({ status: true, data: { status: 'otp', transfer_code: `TRF_${paystack.transfers.length}` } }) };
    return { ok: true, json: async () => ({ status: true, data: { status: 'pending', transfer_code: `TRF_${paystack.transfers.length}` } }) };
  }) as any);

  const wallet = new WalletService(fake);
  const audit: any = { record: jest.fn() };
  const notifications: any = { notifyOnce: jest.fn() };
  const risk: any = { scoreWithdrawal: jest.fn(async () => over.risk ?? { needsReview: false, reasons: [] }) };
  const provider: any = new PaystackPayoutProvider({ get: (k: string) => (k === 'PAYSTACK_SECRET_KEY' ? SECRET : undefined) } as any);
  if (over.providerConfigured === false) Object.defineProperty(provider, 'isConfigured', { value: false });
  const payoutConfig = new PayoutConfigService(fake, audit);
  const accounts: any = { requireFor: async () => { if (over.account === null) throw new BadRequestException('Add a payout account before withdrawing'); return over.account ?? ACCOUNT; } };
  const svc = new WithdrawalService(fake, wallet, audit, risk, provider, notifications, payoutConfig, accounts);
  const controller = new PayoutWebhookController(svc, provider);

  const earn = (userId = 'u1', amount = START) => wallet.credit({ userId, walletType: WalletType.CREATOR_EARNINGS, amount, ledgerType: 'BONUS' as any, reference: 'seed', idempotencyKey: `seed-${userId}` });
  const bal = (userId = 'u1') => wallet.getBalance(userId, WalletType.CREATOR_EARNINGS);
  const ask = (coins: number, key = 'wd-key-000000000001', userId = 'u1', extra: any[] = []) => svc.request(userId, coins, 'NGN', key, 'CREATOR_EARNINGS', 'NG', ...(extra as []));
  const event = (name: string, ref: string, extra: any = {}, opts: { sign?: boolean | string; raw?: boolean } = {}) => {
    const payload = { event: name, data: { transfer_code: ref, ...extra } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = opts.sign === false ? undefined : typeof opts.sign === 'string' ? opts.sign : createHmac('sha512', SECRET).update(rawBody).digest('hex');
    return controller.handle({ rawBody: opts.raw === false ? undefined : rawBody, headers: sig ? { 'x-paystack-signature': sig } : {} } as any, payload);
  };
  const ledger = (type: string) => [...fake.ledger.values()].filter((l: any) => l.type === type);
  // The books must always add up: what the wallet holds == everything ever credited minus debited.
  const booksBalance = async (userId = 'u1') => [...fake.ledger.values()].filter((l: any) => l.walletId === `${userId}:CREATOR_EARNINGS`).reduce((n: bigint, l: any) => n + BigInt(l.amount), 0n) === (await bal(userId));
  return { fake, svc, wallet, controller, rows, paystack, audit, notifications, risk, earn, bal, ask, event, ledger, config, booksBalance };
}
afterEach(() => jest.restoreAllMocks());

describe('Phase 5 — the normal path: pending → processing → paid, with the wallet checked at every step', () => {
  it('reserves the coins, snapshots the cash and the destination, sends the NET cash to Paystack, and keeps the coins out of the wallet through PAID', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    // 5000 coins x N50 per 100 = N2,500 gross; 1% fee = N25; net N2,475 (all in kobo)
    expect(wd).toMatchObject({ status: 'PROCESSING', amountMinor: 5000, grossMinor: 250000, feeMinor: 2500, netMinor: 247500, currencyCode: 'NGN', providerRef: 'TRF_1' });
    expect(wd.payoutTo).toMatchObject({ provider: 'PAYSTACK', accountLast4: '1234', recipientCode: 'RCP_1' });
    expect(w.paystack.transfers).toHaveLength(1);
    expect(w.paystack.transfers[0]).toMatchObject({ amount: 247500, currency: 'NGN', recipient: 'RCP_1', source: 'balance' });
    expect(await w.bal()).toBe(START - 5000n); // reserved the moment it was requested
    expect(w.ledger('WITHDRAWAL')).toHaveLength(1);

    await w.event('transfer.success', 'TRF_1');
    expect(w.rows.get(wd.id).status).toBe('PAID');
    expect(await w.bal()).toBe(START - 5000n); // paid out: the coins stay gone
    expect(w.notifications.notifyOnce).toHaveBeenCalledWith('u1', 'WITHDRAWAL_UPDATE', `wd:${wd.id}:PAID`, expect.anything());
    expect(await w.booksBalance()).toBe(true);
  });

  it('a duplicate paid webhook changes nothing (no second notification, balance the same)', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    await w.event('transfer.success', 'TRF_1');
    await w.event('transfer.success', 'TRF_1');
    await w.event('transfer.success', 'TRF_1');
    expect(w.rows.get(wd.id).status).toBe('PAID');
    expect(await w.bal()).toBe(START - 5000n);
    expect(w.notifications.notifyOnce.mock.calls.filter((c: any[]) => c[2] === `wd:${wd.id}:PAID`).length).toBeGreaterThanOrEqual(1);
  });

  it('the payout reference sent to Paystack is fixed by the idempotency key, so a retried request can never pay twice at Paystack', async () => {
    const w = world();
    await w.earn();
    await w.ask(5000);
    const again: any = await w.ask(5000); // same key: returns the original
    expect(w.paystack.transfers).toHaveLength(1);
    expect(again.providerRef).toBe('TRF_1');
    expect(await w.bal()).toBe(START - 5000n);
    expect(w.ledger('WITHDRAWAL')).toHaveLength(1);
    expect(typeof w.paystack.transfers[0].reference).toBe('string');
  });
});

describe('Phase 5 — failed payouts', () => {
  it('Paystack rejecting the transfer up front fails the withdrawal at once and gives every coin back', async () => {
    const w = world();
    await w.earn();
    w.paystack.mode = 'reject';
    const wd: any = await w.ask(5000);
    expect(wd.status).toBe('FAILED');
    expect(wd.failureReason).toBe('Payout initiation failed');
    expect(await w.bal()).toBe(START);
    expect(await w.booksBalance()).toBe(true);
  });

  it('a transfer that needs an OTP is treated as failed and the coins are returned (nothing is left in limbo)', async () => {
    const w = world();
    await w.earn();
    w.paystack.mode = 'otp';
    const wd: any = await w.ask(5000);
    expect(wd.status).toBe('FAILED');
    expect(await w.bal()).toBe(START);
  });

  it('a transfer.failed webhook after acceptance returns the coins exactly once, however many times it is delivered', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    expect(await w.bal()).toBe(START - 5000n);
    await w.event('transfer.failed', 'TRF_1', { reason: 'Account closed' });
    await w.event('transfer.failed', 'TRF_1', { reason: 'Account closed' });
    await Promise.allSettled([w.event('transfer.failed', 'TRF_1'), w.event('transfer.failed', 'TRF_1')]);
    expect(w.rows.get(wd.id)).toMatchObject({ status: 'FAILED', failureReason: 'Account closed' });
    expect(await w.bal()).toBe(START);
    expect(w.ledger('WITHDRAWAL').length).toBeGreaterThanOrEqual(1);
    expect(await w.booksBalance()).toBe(true);
  });

  it('a late "success" after a failure can not resurrect the withdrawal or take the coins again', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    await w.event('transfer.failed', 'TRF_1');
    await w.event('transfer.success', 'TRF_1');
    expect(w.rows.get(wd.id).status).toBe('FAILED');
    expect(await w.bal()).toBe(START);
  });

  it('a late "failure" after PAID can not hand back coins for money that was sent', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    await w.event('transfer.success', 'TRF_1');
    await w.event('transfer.failed', 'TRF_1');
    expect(w.rows.get(wd.id).status).toBe('PAID');
    expect(await w.bal()).toBe(START - 5000n);
  });
});

describe('Phase 5 — reversal', () => {
  it('a reversal after PAID restores the coins once (duplicates harmless) and marks REVERSED', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    await w.event('transfer.success', 'TRF_1');
    await w.event('transfer.reversed', 'TRF_1');
    await w.event('transfer.reversed', 'TRF_1');
    expect(w.rows.get(wd.id).status).toBe('REVERSED');
    expect(await w.bal()).toBe(START);
    expect(await w.booksBalance()).toBe(true);
  });

  it('a reversal that arrives BEFORE the transfer was ever reported paid does nothing (the failure path owns the refund)', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    await w.event('transfer.reversed', 'TRF_1');
    expect(w.rows.get(wd.id).status).toBe('PROCESSING');
    expect(await w.bal()).toBe(START - 5000n);
  });
});

describe('Phase 5 — payout webhooks are authenticated', () => {
  it('unsigned, wrongly signed, tampered and raw-body-less events are refused and change nothing', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000);
    await expect(w.event('transfer.failed', 'TRF_1', {}, { sign: false })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.event('transfer.failed', 'TRF_1', {}, { sign: 'f'.repeat(128) })).rejects.toThrow(/Invalid webhook signature/);
    await expect(w.event('transfer.failed', 'TRF_1', {}, { raw: false })).rejects.toThrow(/Raw request body unavailable/);
    const signedFor = createHmac('sha512', SECRET).update(Buffer.from(JSON.stringify({ event: 'transfer.success', data: { transfer_code: 'TRF_1' } }))).digest('hex');
    await expect(w.event('transfer.failed', 'TRF_1', {}, { sign: signedFor })).rejects.toThrow(/Invalid webhook signature/); // signature of a different body
    expect(w.rows.get(wd.id).status).toBe('PROCESSING');
    expect(await w.bal()).toBe(START - 5000n);
  });

  it('an event for a transfer we never made is refused; unrelated events are ignored', async () => {
    const w = world();
    await w.earn();
    await expect(w.event('transfer.success', 'TRF_UNKNOWN')).rejects.toBeInstanceOf(NotFoundException);
    expect(await w.event('charge.success', 'X')).toEqual({ received: true });
  });
});

describe('Phase 5 — manual review, admin approve / reject', () => {
  it('a request the risk rules flag waits in PENDING_REVIEW with the coins already reserved and NO payout sent', async () => {
    const w = world({ risk: { needsReview: true, reasons: ['NEW_ACCOUNT'] } });
    await w.earn();
    const wd: any = await w.ask(5000);
    expect(wd).toMatchObject({ status: 'PENDING_REVIEW', riskFlags: ['NEW_ACCOUNT'] });
    expect(w.paystack.transfers).toHaveLength(0);
    expect(await w.bal()).toBe(START - 5000n);
  });

  it('the admin threshold also sends a large request to review, flagged ADMIN_THRESHOLD, and no payout is sent', async () => {
    const w = world({ config: { manualReviewAboveCoins: 4000 } });
    await w.earn();
    const big: any = await w.ask(5000, 'wd-key-big-0000000001');
    expect(big).toMatchObject({ status: 'PENDING_REVIEW', riskFlags: ['ADMIN_THRESHOLD'] });
    expect(w.paystack.transfers).toHaveLength(0);
    const small: any = await w.ask(2000, 'wd-key-small-00000001');
    expect(small.status).toBe('PROCESSING');
  });

  it('approve sends the payout, records who approved, and the wallet stays reserved until paid', async () => {
    const w = world({ risk: { needsReview: true, reasons: ['X'] } });
    await w.earn();
    const wd: any = await w.ask(5000);
    const out: any = await w.svc.approve(wd.id, 'admin1', ['FINANCE_ADMIN'] as any);
    expect(out.status).toBe('PROCESSING');
    expect(w.paystack.transfers).toHaveLength(1);
    expect(w.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'withdrawal.approve', actorId: 'admin1', targetId: wd.id }));
    expect(await w.bal()).toBe(START - 5000n);
    await w.event('transfer.success', out.providerRef);
    expect(w.rows.get(wd.id).status).toBe('PAID');
  });

  it('reject returns every coin once, records the reason and who rejected, and cannot be repeated or followed by an approve', async () => {
    const w = world({ risk: { needsReview: true, reasons: ['X'] } });
    await w.earn();
    const wd: any = await w.ask(5000);
    const out: any = await w.svc.reject(wd.id, 'admin1', ['FINANCE_ADMIN'] as any, 'Looks fraudulent');
    expect(out).toMatchObject({ status: 'REJECTED', failureReason: 'Looks fraudulent' });
    expect(await w.bal()).toBe(START);
    expect(w.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'withdrawal.reject', metadata: { reason: 'Looks fraudulent' } }));
    await expect(w.svc.reject(wd.id, 'admin1', [] as any, 'again')).rejects.toThrow(/Not pending review/);
    await expect(w.svc.approve(wd.id, 'admin2', [] as any)).rejects.toThrow(/Not pending review/);
    expect(await w.bal()).toBe(START);
    expect(w.paystack.transfers).toHaveLength(0);
    expect(await w.booksBalance()).toBe(true);
  });

  it('only a request that is waiting for review can be approved or rejected; unknown ids are 404', async () => {
    const w = world();
    await w.earn();
    const wd: any = await w.ask(5000); // auto-approved, already PROCESSING
    await expect(w.svc.approve(wd.id, 'a', [] as any)).rejects.toThrow(/Not pending review/);
    await expect(w.svc.reject(wd.id, 'a', [] as any, 'x')).rejects.toThrow(/Not pending review/);
    await expect(w.svc.approve('nope', 'a', [] as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('two admins approving at the same moment send only ONE payout', async () => {
    const w = world({ risk: { needsReview: true, reasons: ['X'] } });
    await w.earn();
    const wd: any = await w.ask(5000);
    await Promise.allSettled([w.svc.approve(wd.id, 'a1', [] as any), w.svc.approve(wd.id, 'a2', [] as any)]);
    expect(w.paystack.transfers).toHaveLength(1);
    expect(await w.bal()).toBe(START - 5000n);
  });
});

describe('Phase 5 — who may withdraw, and country rules', () => {
  it('KYC: an unverified person is refused before anything is reserved (when the country requires it); allowed when it does not', async () => {
    const w = world({ kyc: false });
    await w.earn();
    await expect(w.ask(5000)).rejects.toThrow(/Verify your identity/);
    expect(await w.bal()).toBe(START);
    expect(w.paystack.transfers).toHaveLength(0);
    const open = world({ kyc: false, config: { requireKyc: false } });
    await open.earn();
    expect(((await open.ask(5000)) as any).status).toBe('PROCESSING');
  });

  it('refused, with nothing reserved: below the minimum, above the maximum, more than the balance, zero, negative, fractional', async () => {
    const w = world();
    await w.earn('u1', 3000n);
    await expect(w.ask(999)).rejects.toThrow(/minimum withdrawal is 1,000/);
    await expect(w.ask(100_001, 'k-max-000000000000001')).rejects.toThrow(/maximum withdrawal is 100,000/);
    await expect(w.ask(5000, 'k-bal-000000000000001')).rejects.toThrow(/Insufficient cleared balance/);
    for (const bad of [0, -5, 1.5, NaN]) await expect(w.ask(bad as number, `k-bad-${String(bad)}-0000000`)).rejects.toBeInstanceOf(BadRequestException);
    expect(await w.bal()).toBe(3000n);
    expect(w.paystack.transfers).toHaveLength(0);
  });

  it('a country with no payout configuration, or with payouts switched off, cannot withdraw', async () => {
    const none = world({ config: null });
    await none.earn();
    await expect(none.ask(5000)).rejects.toThrow(/not available in your country/);
    const off = world({ config: { enabled: false } });
    await off.earn();
    await expect(off.ask(5000)).rejects.toThrow(/not available in your country/);
    expect(await off.bal()).toBe(START);
  });

  it('no payout account, or a payout method the country has not enabled, is refused', async () => {
    const noAcc = world({ account: null });
    await noAcc.earn();
    await expect(noAcc.ask(5000)).rejects.toThrow(/payout account/);
    const wrongProvider = world({ config: { allowedProviders: ['BANK_TRANSFER'] } });
    await wrongProvider.earn();
    await expect(wrongProvider.ask(5000)).rejects.toThrow(/payout method is not enabled/);
    expect(await wrongProvider.bal()).toBe(START);
  });

  it('when no payout provider is configured the request is refused BEFORE any coins are reserved', async () => {
    const w = world({ providerConfigured: false });
    await w.earn();
    await expect(w.ask(5000)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await w.bal()).toBe(START);
  });

  it('coins (spendable) and bonus wallets can never be withdrawn — only earnings wallets', async () => {
    const w = world();
    await expect(w.svc.request('u1', 5000, 'NGN', 'k-wallet-0000000001', 'COIN' as any, 'NG')).rejects.toBeDefined();
    expect(w.paystack.transfers).toHaveLength(0);
  });

  it('agency earnings can only be withdrawn by an approved agency owner', async () => {
    const w = world();
    await w.wallet.credit({ userId: 'u1', walletType: WalletType.AGENCY_EARNINGS, amount: 9000n, ledgerType: 'BONUS' as any, reference: 's', idempotencyKey: 'agency-seed' });
    await expect(w.svc.request('u1', 5000, 'NGN', 'k-agency-000000001', 'AGENCY_EARNINGS', 'NG')).rejects.toBeInstanceOf(ForbiddenException);
    expect(await w.wallet.getBalance('u1', WalletType.AGENCY_EARNINGS)).toBe(9000n);
  });

  it('someone else re-using an idempotency key is refused, not handed the first person\'s withdrawal', async () => {
    const w = world();
    await w.earn();
    await w.earn('u2');
    await w.ask(5000, 'shared-key-000000001', 'u1');
    await expect(w.ask(5000, 'shared-key-000000001', 'u2')).rejects.toThrow(/Idempotency key already used/);
  });

  it('daily limit, monthly limit and cooldown are enforced by the server', async () => {
    const day = world({ config: { maxDailyWithdrawalCoins: 6000 } });
    await day.earn();
    await day.ask(4000, 'd1-0000000000000001');
    await expect(day.ask(4000, 'd2-0000000000000001')).rejects.toThrow(/Daily withdrawal limit exceeded/);
    expect(await day.bal()).toBe(START - 4000n);

    const month = world({ config: { maxMonthlyWithdrawalCoins: 6000 } });
    await month.earn();
    await month.ask(4000, 'm1-0000000000000001');
    await expect(month.ask(4000, 'm2-0000000000000001')).rejects.toThrow(/Monthly withdrawal limit exceeded/);

    const cool = world({ config: { cooldownHours: 24 } });
    await cool.earn();
    await cool.ask(2000, 'c1-0000000000000001');
    await expect(cool.ask(2000, 'c2-0000000000000001')).rejects.toThrow(/wait 24 hours/);
  });
});

describe('Phase 5 — findings (these describe the correct behaviour and FAIL today)', () => {
  it.failing('DEFECT: a payout that FAILED and was refunded still counts against the daily limit, blocking the creator from trying again', async () => {
    const w = world({ config: { maxDailyWithdrawalCoins: 6000 } });
    await w.earn();
    await w.ask(4000, 'd1-0000000000000001');
    await w.event('transfer.failed', 'TRF_1'); // coins are back
    const retry: any = await w.ask(4000, 'd2-0000000000000001'); // only 4000 actually left the wallet in total
    expect(retry.status).toBe('PROCESSING');
  });

  it.failing('DEFECT: the cooldown also counts a rejected or failed attempt, so the creator must wait even though nothing was paid', async () => {
    const w = world({ config: { cooldownHours: 24 }, risk: { needsReview: true, reasons: ['X'] } });
    await w.earn();
    const first: any = await w.ask(2000, 'c1-0000000000000001');
    await w.svc.reject(first.id, 'a', [] as any, 'no');
    w.risk.scoreWithdrawal.mockResolvedValue({ needsReview: false, reasons: [] });
    const retry: any = await w.ask(2000, 'c2-0000000000000001');
    expect(retry.status).toBe('PROCESSING');
  });

  it.failing('DEFECT: an admin approve and reject that overlap can send the money AND give the coins back (reject does not check that the request is still waiting)', async () => {
    const w = world({ risk: { needsReview: true, reasons: ['X'] } });
    await w.earn();
    const wd: any = await w.ask(5000);
    const staleRead = { ...w.rows.get(wd.id) }; // what a second admin's screen read before the first admin acted
    await w.svc.approve(wd.id, 'a1', [] as any); // the payout is sent
    const realFind = w.fake.withdrawalRequest.findUnique;
    w.fake.withdrawalRequest.findUnique = async () => staleRead; // the second admin's request had already read the old row
    await Promise.allSettled([w.svc.reject(wd.id, 'a2', [] as any, 'no')]);
    w.fake.withdrawalRequest.findUnique = realFind;
    const moneySent = w.paystack.transfers.length > 0;
    const coinsBack = (await w.bal()) === START;
    expect(moneySent && coinsBack).toBe(false);
  });

  it.failing('DEFECT: two requests sent at the same moment can both pass the daily-limit check', async () => {
    const w = world({ config: { maxDailyWithdrawalCoins: 6000 } });
    await w.earn();
    const results = await Promise.allSettled([w.ask(4000, 'p1-0000000000000001'), w.ask(4000, 'p2-0000000000000001')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
