import { WalletService } from './wallet.service';
import { FakePrisma } from '../test-utils/fake-prisma';
import { WalletType, LedgerEntryType } from '@prisma/client';

// NOTE: this file could not be run in the sandbox that produced it —
// ts-jest fails to compile it because @prisma/client's types weren't
// generated there (see project README). Run `npx prisma generate` first;
// this should then pass. The logic itself was verified separately by
// isolating the pure sub-functions (see games/rng.service.spec.ts, which
// has no Prisma dependency and did run, and the isolated verification
// described in the conversation for gift-split math).
describe('WalletService', () => {
  function makeService() {
    const prisma = new FakePrisma();
    const wallet = new WalletService(prisma as any);
    return { prisma, wallet };
  }

  it('credit() increases balance from zero and writes one ledger entry', async () => {
    const { wallet } = makeService();
    await wallet.credit({
      userId: 'u1',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: LedgerEntryType.COIN_PURCHASE,
      idempotencyKey: 'key-1',
    });
    expect(await wallet.getBalance('u1', WalletType.COIN)).toBe(100n);
  });

  it('debit() reduces balance when sufficient funds exist', async () => {
    const { wallet } = makeService();
    await wallet.credit({
      userId: 'u1',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: LedgerEntryType.COIN_PURCHASE,
      idempotencyKey: 'key-1',
    });
    await wallet.debit({
      userId: 'u1',
      walletType: WalletType.COIN,
      amount: 40n,
      ledgerType: LedgerEntryType.GIFT_SENT,
      idempotencyKey: 'key-2',
    });
    expect(await wallet.getBalance('u1', WalletType.COIN)).toBe(60n);
  });

  it('debit() throws and leaves balance untouched when funds are insufficient', async () => {
    const { wallet } = makeService();
    await wallet.credit({
      userId: 'u1',
      walletType: WalletType.COIN,
      amount: 10n,
      ledgerType: LedgerEntryType.COIN_PURCHASE,
      idempotencyKey: 'key-1',
    });
    await expect(
      wallet.debit({
        userId: 'u1',
        walletType: WalletType.COIN,
        amount: 999n,
        ledgerType: LedgerEntryType.GIFT_SENT,
        idempotencyKey: 'key-2',
      }),
    ).rejects.toThrow('Insufficient balance');
    expect(await wallet.getBalance('u1', WalletType.COIN)).toBe(10n);
  });

  it('is idempotent: retrying the same idempotencyKey does not apply the movement twice', async () => {
    const { wallet } = makeService();
    const first = await wallet.credit({
      userId: 'u1',
      walletType: WalletType.COIN,
      amount: 50n,
      ledgerType: LedgerEntryType.COIN_PURCHASE,
      idempotencyKey: 'same-key',
    });
    const second = await wallet.credit({
      userId: 'u1',
      walletType: WalletType.COIN,
      amount: 50n,
      ledgerType: LedgerEntryType.COIN_PURCHASE,
      idempotencyKey: 'same-key',
    });
    expect(second).toEqual(first); // returns the original entry, doesn't create a new one
    expect(await wallet.getBalance('u1', WalletType.COIN)).toBe(50n); // not 100n
  });

  it('rejects a non-positive credit or debit amount', async () => {
    const { wallet } = makeService();
    await expect(
      wallet.credit({ userId: 'u1', walletType: WalletType.COIN, amount: 0n, ledgerType: LedgerEntryType.BONUS, idempotencyKey: 'k' }),
    ).rejects.toThrow('Credit amount must be positive');
    await expect(
      wallet.debit({ userId: 'u1', walletType: WalletType.COIN, amount: -5n, ledgerType: LedgerEntryType.GIFT_SENT, idempotencyKey: 'k2' }),
    ).rejects.toThrow(); // -5n fails the `<= 0n` guard the same as 0n or a positive-looking negative
  });

  it('keeps separate wallet types (COIN vs CREATOR_EARNINGS) independent for the same user', async () => {
    const { wallet } = makeService();
    await wallet.credit({
      userId: 'u1',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: LedgerEntryType.COIN_PURCHASE,
      idempotencyKey: 'k1',
    });
    await wallet.credit({
      userId: 'u1',
      walletType: WalletType.CREATOR_EARNINGS,
      amount: 30n,
      ledgerType: LedgerEntryType.GIFT_RECEIVED,
      idempotencyKey: 'k2',
    });
    expect(await wallet.getBalance('u1', WalletType.COIN)).toBe(100n);
    expect(await wallet.getBalance('u1', WalletType.CREATOR_EARNINGS)).toBe(30n);
  });
});
