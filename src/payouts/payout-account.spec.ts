import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ACCOUNT_CHANGE_COOLDOWN_MS, PayoutAccountService, cooldownRemainingMs, isValidAccountNumber, isValidBankCode } from './payout-account.service';

describe('validation helpers', () => {
  it('accepts a 10-digit account number and a sane bank code only', () => {
    expect(isValidAccountNumber('0123456789')).toBe(true);
    expect(isValidAccountNumber('012345678')).toBe(false);
    expect(isValidAccountNumber('01234567ab')).toBe(false);
    expect(isValidAccountNumber(123456789012)).toBe(false);
    expect(isValidBankCode('058')).toBe(true);
    expect(isValidBankCode("058'; DROP")).toBe(false);
  });

  it('cooldown counts down from the last change', () => {
    const changed = new Date(1_000_000);
    expect(cooldownRemainingMs(changed, 1_000_000)).toBe(ACCOUNT_CHANGE_COOLDOWN_MS);
    expect(cooldownRemainingMs(changed, 1_000_000 + ACCOUNT_CHANGE_COOLDOWN_MS)).toBe(0);
    expect(cooldownRemainingMs(changed, 1_000_000 + ACCOUNT_CHANGE_COOLDOWN_MS + 5)).toBe(0);
  });
});

describe('PayoutAccountService.save', () => {
  const build = async (existing: any = null) => {
    const passwordHash = await argon2.hash('correct horse battery', { type: argon2.argon2id });
    const upsert = jest.fn(async ({ create }: any) => ({ ...create, updatedAt: new Date() }));
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ passwordHash }) },
      payoutAccount: { findUnique: jest.fn().mockResolvedValue(existing), upsert },
    };
    const audit: any = { record: jest.fn() };
    const notifications: any = { notify: jest.fn() };
    const banks: any = {
      id: 'PAYSTACK',
      listBanks: jest.fn().mockResolvedValue([{ code: '058', name: 'GTBank' }]),
      resolveAccount: jest.fn().mockResolvedValue({ accountName: 'ADA OBI' }),
      createRecipient: jest.fn().mockResolvedValue({ recipientCode: 'RCP_xyz' }),
    };
    return { svc: new PayoutAccountService(prisma, audit, notifications, banks), prisma, audit, notifications, banks, upsert };
  };
  const input = { bankCode: '058', accountNumber: '0123456789', password: 'correct horse battery' };

  it('takes the account name from the bank lookup and stores only the last 4 digits', async () => {
    const { svc, upsert, banks } = await build();
    const view = await svc.save('u1', 'NG', { ...input, accountName: 'HACKER' } as any);
    expect(banks.resolveAccount).toHaveBeenCalledWith('058', '0123456789');
    const stored = upsert.mock.calls[0][0].create;
    expect(stored).toMatchObject({ accountName: 'ADA OBI', accountLast4: '6789', recipientCode: 'RCP_xyz', bankName: 'GTBank' });
    expect(JSON.stringify(stored)).not.toContain('0123456789'); // the full number is never stored
    expect(view).not.toHaveProperty('recipientCode');
    expect(view.accountLast4).toBe('6789');
  });

  it('rejects a wrong password without contacting the bank', async () => {
    const { svc, banks } = await build();
    await expect(svc.save('u1', 'NG', { ...input, password: 'nope' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(banks.createRecipient).not.toHaveBeenCalled();
  });

  it('blocks a second change inside the cooldown, and allows one after it', async () => {
    const recent = { updatedAt: new Date(Date.now() - 60 * 60 * 1000), accountLast4: '1111' };
    const blocked = await build(recent);
    await expect(blocked.svc.save('u1', 'NG', input)).rejects.toThrow(/changed recently/);
    expect(blocked.banks.createRecipient).not.toHaveBeenCalled();

    const old = { updatedAt: new Date(Date.now() - ACCOUNT_CHANGE_COOLDOWN_MS - 1000), accountLast4: '1111' };
    const allowed = await build(old);
    await expect(allowed.svc.save('u1', 'NG', input)).resolves.toBeDefined();
  });

  it('tells the owner (and audits it) every time the payout account is set or changed', async () => {
    const { svc, notifications, audit } = await build({ updatedAt: new Date(0), accountLast4: '1111' });
    await svc.save('u1', 'NG', input);
    expect(notifications.notify).toHaveBeenCalledWith('u1', 'SECURITY', expect.objectContaining({ event: 'payout_account_changed', accountLast4: '6789' }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'payout_account.change' }));
  });

  it('rejects an unknown bank and unsupported countries', async () => {
    const { svc } = await build();
    await expect(svc.save('u1', 'NG', { ...input, bankCode: '999' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.save('u1', 'GH', input)).rejects.toThrow(/not available in your country/);
  });
});
