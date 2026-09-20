import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, WalletType, LedgerEntryType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';

export interface LedgerMovement {
  userId: string;
  walletType: WalletType;
  amount: bigint; // positive to credit, negative to debit — caller states intent explicitly via credit()/debit()
  ledgerType: LedgerEntryType;
  reference?: string;
  idempotencyKey: string;
  currencyCode?: string; // required only when the wallet doesn't exist yet
}

// This is the ONLY place wallet balances are read for mutation or written.
// Every other module (gifts, coin purchases, games, withdrawals, PK) must
// route through here — never touch `Wallet.balance` directly from another
// service. That's what makes "client cannot modify balance" (spec §93) and
// "duplicate requests cannot double-charge" (spec §69) actually true.
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateWallet(
    tx: Prisma.TransactionClient,
    userId: string,
    type: WalletType,
    currencyCode: string,
  ) {
    return tx.wallet.upsert({
      where: { userId_type: { userId, type } },
      update: {},
      create: { userId, type, currencyCode, balance: 0n },
    });
  }

  async getBalance(userId: string, type: WalletType) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId_type: { userId, type } } });
    return wallet?.balance ?? 0n;
  }

  // Credits a wallet. Amount must be positive — this function always adds.
  // Idempotent: if idempotencyKey was already used, returns the existing
  // ledger entry instead of applying the movement twice.
  //
  // Optional `tx`: pass an existing Prisma.TransactionClient (from the
  // caller's own `this.prisma.$transaction(async (tx) => ...)`) when this
  // credit needs to succeed-or-fail atomically together with another write
  // — e.g. crediting a wallet and creating the record that justifies it.
  // Without this, a failure in that second write after the credit already
  // committed silently moves money with no corresponding record — a real
  // bug this was added specifically to close, found via a failed
  // GameEntry.create() after a successful debit.
  async credit(mv: Omit<LedgerMovement, 'amount'> & { amount: bigint }, tx?: Prisma.TransactionClient) {
    if (mv.amount <= 0n) throw new BadRequestException('Credit amount must be positive');
    return this.applyMovement({ ...mv, amount: mv.amount }, false, tx);
  }

  // Debits a wallet. Amount must be positive (the sign is applied
  // internally) and the wallet must have sufficient balance — this is not
  // an overdraft-capable ledger. See credit()'s comment for the optional
  // `tx` parameter.
  async debit(mv: Omit<LedgerMovement, 'amount'> & { amount: bigint }, tx?: Prisma.TransactionClient) {
    if (mv.amount <= 0n) throw new BadRequestException('Debit amount must be positive');
    return this.applyMovement({ ...mv, amount: -mv.amount }, /* requireSufficientFunds */ true, tx);
  }

  // DANGEROUS — bypasses the sufficient-funds check and lets a wallet go
  // negative. Exists for exactly one case: clawing back coins after a
  // chargeback, where the coins may have already been spent (on gifts,
  // games, etc.) and the alternative — refusing to record the clawback at
  // all — is worse than an accurate negative balance. A negative COIN
  // balance is itself a strong signal (see risk-rules.ts) and should block
  // further spending/withdrawal until resolved, which is enforced by
  // callers checking the balance, not by this method. Never call this from
  // anywhere except ChargebackService.
  async forceDebit(mv: Omit<LedgerMovement, 'amount'> & { amount: bigint }, tx?: Prisma.TransactionClient) {
    if (mv.amount <= 0n) throw new BadRequestException('Debit amount must be positive');
    return this.applyMovement({ ...mv, amount: -mv.amount }, /* requireSufficientFunds */ false, tx);
  }

  private async applyMovement(mv: LedgerMovement, requireSufficientFunds = false, externalTx?: Prisma.TransactionClient) {
    const run = async (tx: Prisma.TransactionClient) => {
      // Idempotency check first — cheap short-circuit before touching balances.
      const existing = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: mv.idempotencyKey } });
      if (existing) return existing;

      const wallet = await this.getOrCreateWallet(
        tx,
        mv.userId,
        mv.walletType,
        mv.currencyCode ?? 'COIN', // coin wallets are currency-agnostic (they hold coins, not fiat)
      );

      const newBalance = wallet.balance + mv.amount;
      if (requireSufficientFunds && newBalance < 0n) {
        throw new BadRequestException('Insufficient balance');
      }

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      });

      // Unique constraint on idempotencyKey is the real guarantee against
      // double-processing under concurrent retries — the findUnique check
      // above is an optimization, not the source of truth.
      try {
        return await tx.ledgerEntry.create({
          data: {
            walletId: updated.id,
            type: mv.ledgerType,
            amount: mv.amount,
            balanceAfter: updated.balance,
            reference: mv.reference,
            idempotencyKey: mv.idempotencyKey,
          },
        });
      } catch (e: any) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // Lost a race with a concurrent identical request — the other
          // request's write is authoritative; ours must roll back (thrown
          // inside $transaction), then we return the winner's entry.
          throw new IdempotentRaceError(mv.idempotencyKey);
        }
        throw e;
      }
    };

    if (externalTx) {
      // Caller already owns a transaction boundary (their own
      // $transaction callback) — run inside it directly rather than
      // opening a second, nested one. No separate timeout override here;
      // the caller's own $transaction options govern. A P2002 race in this
      // path fails the caller's whole transaction rather than being
      // silently absorbed by the fallback lookup below — appropriate,
      // since two concurrent requests each trying to open their own
      // top-level transaction around the same idempotencyKey is the actual
      // race that fallback exists for, not two operations inside one
      // caller-owned transaction.
      return run(externalTx);
    }

    return this.prisma.$transaction(run, EXTENDED_TX_OPTIONS).catch(async (e: any) => {
      if (e instanceof IdempotentRaceError) {
        const winner = await this.prisma.ledgerEntry.findUnique({ where: { idempotencyKey: e.idempotencyKey } });
        if (winner) return winner;
      }
      throw e;
    });
  }

  // Platform-level entries not tied to any user wallet (e.g. recording the
  // platform's share of a gift). walletId is null by design — see schema
  // comment on LedgerEntry.walletId. Same optional `tx` for the same
  // atomicity reason as credit()/debit().
  async recordPlatformEntry(
    params: {
      ledgerType: LedgerEntryType;
      amount: bigint;
      reference?: string;
      idempotencyKey: string;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const existing = await client.ledgerEntry.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) return existing;
    return client.ledgerEntry.create({
      data: {
        walletId: null,
        type: params.ledgerType,
        amount: params.amount,
        reference: params.reference,
        idempotencyKey: params.idempotencyKey,
      },
    });
  }
}

class IdempotentRaceError extends Error {
  constructor(public idempotencyKey: string) {
    super('idempotent race');
  }
}
