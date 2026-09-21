import { WalletType } from '@prisma/client';
import { FakePrisma } from '../test-utils/fake-prisma';
import { WalletService } from '../economy/wallet.service';
import { ReconciliationService } from './reconciliation.service';

// Wallet reconciliation against real wallet movements: after a mix of credits, debits,
// retries and refused spends, every wallet must equal the sum of its own ledger — and if a
// balance is ever changed WITHOUT a ledger entry (a bug, or someone editing the database),
// the check must find it and say by how much.
function books() {
  const fake: any = new FakePrisma();
  fake.wallet.findMany = async () => [...fake.wallets.values()].map((w: any) => ({ id: w.id, balance: w.balance }));
  fake.wallet.findUniqueOrThrow = async ({ where: { id } }: any) => [...fake.wallets.values()].find((w: any) => w.id === id);
  fake.ledgerEntry.aggregate = async ({ where: { walletId } }: any) => ({ _sum: { amount: [...fake.ledger.values()].filter((l: any) => l.walletId === walletId).reduce((n: bigint, l: any) => n + BigInt(l.amount), 0n) } });
  return { fake, wallet: new WalletService(fake), recon: new ReconciliationService(fake) };
}
const move = (i: number) => ({ reference: `r${i}`, idempotencyKey: `k${i}` });

describe('wallet reconciliation', () => {
  it('finds no discrepancy after credits, debits, idempotent retries, a refused overspend, and a forced clawback', async () => {
    const { wallet, recon } = books();
    await wallet.credit({ userId: 'a', walletType: WalletType.COIN, amount: 1000n, ledgerType: 'COIN_PURCHASE' as any, ...move(1) });
    await wallet.credit({ userId: 'a', walletType: WalletType.COIN, amount: 1000n, ledgerType: 'COIN_PURCHASE' as any, ...move(1) }); // replayed
    await wallet.debit({ userId: 'a', walletType: WalletType.COIN, amount: 300n, ledgerType: 'GIFT_SENT' as any, ...move(2) });
    await expect(wallet.debit({ userId: 'a', walletType: WalletType.COIN, amount: 5000n, ledgerType: 'GIFT_SENT' as any, ...move(3) })).rejects.toThrow(/Insufficient/);
    await wallet.forceDebit({ userId: 'a', walletType: WalletType.COIN, amount: 900n, ledgerType: 'CHARGEBACK' as any, ...move(4) });
    await wallet.credit({ userId: 'b', walletType: WalletType.CREATOR_EARNINGS, amount: 70n, ledgerType: 'BONUS' as any, ...move(5) });
    expect(await wallet.getBalance('a', WalletType.COIN)).toBe(-200n);
    const r = await recon.checkAll();
    expect(r.checked).toBe(2);
    expect(r.discrepancies).toEqual([]);
  });

  it('catches a balance changed without a ledger entry, and reports which wallet and by how much', async () => {
    const { fake, wallet, recon } = books();
    await wallet.credit({ userId: 'a', walletType: WalletType.COIN, amount: 1000n, ledgerType: 'COIN_PURCHASE' as any, ...move(1) });
    await wallet.credit({ userId: 'b', walletType: WalletType.COIN, amount: 50n, ledgerType: 'COIN_PURCHASE' as any, ...move(2) });
    fake.wallets.get('a:COIN').balance += 250n; // someone edits the balance directly
    const r = await recon.checkAll();
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toMatchObject({ walletId: 'a:COIN', ok: false, discrepancy: 250n });
    expect((await recon.checkWallet('b:COIN')).ok).toBe(true);
    expect((await recon.checkWallet('a:COIN')).discrepancy).toBe(250n);
  });

  it('catches a ledger entry with no matching balance change (money recorded but never applied)', async () => {
    const { fake, wallet, recon } = books();
    await wallet.credit({ userId: 'a', walletType: WalletType.COIN, amount: 100n, ledgerType: 'COIN_PURCHASE' as any, ...move(1) });
    fake.ledger.set('orphan', { id: 'orphan', walletId: 'a:COIN', type: 'ADJUSTMENT', amount: 40n, balanceAfter: 140n, reference: 'x', idempotencyKey: 'orphan' });
    expect((await recon.checkAll()).discrepancies[0]).toMatchObject({ walletId: 'a:COIN', discrepancy: -40n });
  });
});
