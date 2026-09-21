import { WalletType } from '@prisma/client';
import { FakePrisma } from '../test-utils/fake-prisma';
import { grantCoins } from './grant-coins';

function build(existing = 0n) {
  const prisma: any = new FakePrisma();
  const users = [{ id: 'u1', email: 'donchris4life2006@gmail.com', displayName: 'Don' }];
  prisma.user.findFirst = jest.fn(async ({ where }: any) => users.find((u) => u.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null);
  prisma.auditLog = { create: jest.fn() };
  if (existing > 0n) prisma.wallets.set('u1:COIN', { id: 'u1:COIN', userId: 'u1', type: 'COIN', balance: existing });
  return prisma;
}

describe('grantCoins', () => {
  it('by default only previews: nothing is changed', async () => {
    const prisma = build(50n);
    const r = await grantCoins(prisma, { email: 'donchris4life2006@gmail.com', amount: 500, apply: false });
    expect(r).toMatchObject({ applied: false, before: 50n, after: 550n });
    expect(prisma.ledger.size).toBe(0);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.wallets.get('u1:COIN').balance).toBe(50n);
  });

  it('adds the coins, writes a ledger entry with the note, and audits it', async () => {
    const prisma = build(50n);
    const r = await grantCoins(prisma, { email: 'donchris4life2006@gmail.com', amount: 500, note: 'support gift', apply: true });
    expect(r).toMatchObject({ applied: true, before: 50n, after: 550n });
    expect(prisma.wallets.get('u1:COIN').balance).toBe(550n);
    const entry = [...prisma.ledger.values()][0];
    expect(entry).toMatchObject({ type: 'ADJUSTMENT', amount: 500n, balanceAfter: 550n, reference: 'admin grant: support gift' });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'wallet.admin_grant', targetId: 'u1', metadata: expect.objectContaining({ amount: 500, wallet: 'COIN' }) });
  });

  it('creates the wallet if the person has none yet', async () => {
    const prisma = build();
    const r = await grantCoins(prisma, { email: 'donchris4life2006@gmail.com', amount: 100, apply: true });
    expect(r).toMatchObject({ before: 0n, after: 100n });
  });

  it('finds the person whatever the capital letters, and can give game-only bonus coins', async () => {
    const prisma = build();
    const r = await grantCoins(prisma, { email: 'DonChris4Life2006@Gmail.com', amount: 200, wallet: 'BONUS', apply: true });
    expect(r.walletType).toBe(WalletType.BONUS);
    expect([...prisma.ledger.values()][0].type).toBe('BONUS');
  });

  it('refuses an unknown email, and amounts that are not whole numbers from 1 to 10,000,000', async () => {
    const prisma = build();
    await expect(grantCoins(prisma, { email: 'nobody@example.com', amount: 5, apply: true })).rejects.toThrow(/No user with the email/);
    for (const amount of [0, -5, 1.5, 10_000_001, NaN]) {
      await expect(grantCoins(prisma, { email: 'donchris4life2006@gmail.com', amount, apply: true })).rejects.toThrow(/whole number from 1 to 10,000,000/);
    }
    await expect(grantCoins(prisma, { email: '  ', amount: 5, apply: true })).rejects.toThrow(/email is required/);
    expect(prisma.ledger.size).toBe(0);
  });

  it('running it twice adds twice (each grant is its own deliberate action)', async () => {
    const prisma = build();
    await grantCoins(prisma, { email: 'donchris4life2006@gmail.com', amount: 100, apply: true });
    await grantCoins(prisma, { email: 'donchris4life2006@gmail.com', amount: 100, apply: true });
    expect(prisma.wallets.get('u1:COIN').balance).toBe(200n);
  });
});
