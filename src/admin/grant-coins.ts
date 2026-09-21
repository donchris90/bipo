import { randomUUID } from 'crypto';
import { LedgerEntryType, WalletType } from '@prisma/client';
import { WalletService } from '../economy/wallet.service';

export const MAX_GRANT = 10_000_000;

export interface GrantCoinsInput {
  email: string;
  amount: number;
  // COIN: spendable anywhere (gifts, games). BONUS: game-only coins.
  wallet?: 'COIN' | 'BONUS';
  note?: string;
  // false = only show what would happen
  apply: boolean;
}

// Adds coins to one person's wallet by hand — for a support gift, a test account,
// making good on a failed purchase. It goes through the same wallet code as every other
// coin movement (so the balance and the ledger always agree), is recorded as an
// ADJUSTMENT (or BONUS) in the ledger with a note, and is written to the audit log.
// By default it only PREVIEWS; nothing changes until `apply` is true.
export async function grantCoins(prisma: any, input: GrantCoinsInput) {
  const email = (input.email ?? '').trim();
  if (!email) throw new Error('An email is required');
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_GRANT) {
    throw new Error(`The amount must be a whole number from 1 to ${MAX_GRANT.toLocaleString('en-US')}`);
  }
  const note = (input.note ?? '').trim().slice(0, 100);
  const walletType = input.wallet === 'BONUS' ? WalletType.BONUS : WalletType.COIN;

  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true, email: true, displayName: true } });
  if (!user) throw new Error(`No user with the email ${email}. They need to register in the app first.`);

  const wallets = new WalletService(prisma);
  const before = await wallets.getBalance(user.id, walletType);
  if (!input.apply) return { applied: false as const, user, walletType, before, after: before + BigInt(input.amount) };

  const key = `admin-grant:${randomUUID()}`;
  const entry = await wallets.credit({
    userId: user.id,
    walletType,
    amount: BigInt(input.amount),
    ledgerType: walletType === WalletType.BONUS ? LedgerEntryType.BONUS : LedgerEntryType.ADJUSTMENT,
    reference: `admin grant${note ? `: ${note}` : ''}`,
    idempotencyKey: key,
  });
  await prisma.auditLog.create({
    data: { action: 'wallet.admin_grant', targetType: 'user', targetId: user.id, metadata: { amount: input.amount, wallet: walletType, note: note || null, ledgerEntryId: entry.id, via: 'script' } },
  });
  const after = await wallets.getBalance(user.id, walletType);
  return { applied: true as const, user, walletType, before, after };
}
