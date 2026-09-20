import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { AuditService } from '../audit/audit.service';
import { RiskService } from '../risk/risk.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PayoutConfigService } from '../payouts/payout-config.service';
import { PayoutAccountService } from '../payouts/payout-account.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import type { PayoutProvider } from './providers/payout-provider.interface';
import { WalletType, LedgerEntryType, RoleName } from '@prisma/client';

export const PAYOUT_PROVIDER = 'PAYOUT_PROVIDER';

// The only wallets that can be paid out. COIN (spendable) and BONUS are not
// withdrawable.
export type WithdrawableWallet = 'CREATOR_EARNINGS' | 'AGENCY_EARNINGS';
export const WITHDRAWABLE_WALLETS: WithdrawableWallet[] = ['CREATOR_EARNINGS', 'AGENCY_EARNINGS'];

export function parseWithdrawableWallet(raw: unknown, fallback: WithdrawableWallet = 'CREATOR_EARNINGS'): WithdrawableWallet {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (WITHDRAWABLE_WALLETS.includes(raw as WithdrawableWallet)) return raw as WithdrawableWallet;
  throw new BadRequestException("walletType must be 'CREATOR_EARNINGS' or 'AGENCY_EARNINGS'");
}

@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
    private readonly risk: RiskService,
    @Inject(PAYOUT_PROVIDER) private readonly payoutProvider: PayoutProvider,
    private readonly notifications: NotificationsService,
    private readonly payoutConfig: PayoutConfigService,
    private readonly payoutAccounts: PayoutAccountService,
  ) {}

  // `creatorId` is the requesting user. `walletType` picks which of their
  // wallets is drawn on: CREATOR_EARNINGS (default, unchanged behavior) or
  // AGENCY_EARNINGS, which only an approved agency's owner may withdraw.
  async request(
    creatorId: string,
    amountCoins: number,
    currencyCode: string,
    idempotencyKey: string,
    walletType: WithdrawableWallet = 'CREATOR_EARNINGS',
    countryCode = 'NG',
  ) {
    // BigInt(1.5) throws a RangeError, so a fractional amount would have
    // surfaced as a 500 rather than a clear 400.
    // Refuse before anything is reserved if payouts can't actually happen.
    if (this.payoutProvider.isConfigured === false) {
      throw new ServiceUnavailableException('Payouts are not available yet. Your earnings are safe and unchanged.');
    }

    if (!Number.isInteger(amountCoins) || amountCoins <= 0) {
      throw new BadRequestException('Amount must be a positive whole number of coins');
    }

    const existing = await this.prisma.withdrawalRequest.findUnique({ where: { idempotencyKey } });
    if (existing) {
      // An idempotent retry returns the original — but only to the user who
      // made it. Another user presenting the same key must not be handed
      // someone else's withdrawal record.
      if (existing.creatorId !== creatorId) throw new BadRequestException('Idempotency key already used');
      return existing;
    }

    if (walletType === 'AGENCY_EARNINGS') {
      const agency = await this.prisma.agency.findFirst({ where: { ownerId: creatorId, status: 'APPROVED' } });
      if (!agency) throw new ForbiddenException('Only an approved agency owner can withdraw agency earnings');
    }

    // The cash figures come from the admin's payout settings for the person's
    // country (rate, minimum, maximum, fees) — the client's `currencyCode` is
    // ignored. And there must be somewhere to send the money.
    const quote = await this.payoutConfig.requireQuote(countryCode, amountCoins);
    // Money only goes to someone whose identity has been checked (an admin
    // setting, on by default).
    if (quote.requireKyc) {
      const person = await this.prisma.user.findUnique({ where: { id: creatorId }, select: { kycVerified: true } });
      if (!person?.kycVerified) throw new ForbiddenException('Verify your identity before withdrawing');
    }
    const account = await this.payoutAccounts.requireFor(creatorId);

    const balance = await this.wallet.getBalance(creatorId, WalletType[walletType]);
    if (balance < BigInt(amountCoins)) throw new BadRequestException('Insufficient cleared balance');

    // Computed before the transaction below — a read of existing state
    // (account age, prior withdrawals, etc.), not something this
    // withdrawal's own reserve affects, so it doesn't need to be inside
    // the atomic block.
    const risk = await this.risk.scoreWithdrawal(creatorId, amountCoins, walletType);

    // Same fix as EntryService.place()/GiftService.send(): the reserve
    // debit and the WithdrawalRequest record it justifies must commit
    // together. Before this, a failure in withdrawalRequest.create() after
    // a successful reserve debit would leave a creator's earnings debited
    // with no withdrawal record anywhere — real money with no paper trail,
    // the same bug class found live in the game entry flow.
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      // Reserve: debit immediately so the funds can't be double-spent (e.g.
      // via a gift) while the withdrawal is pending review or in flight.
      await this.wallet.debit(
        {
          userId: creatorId,
          walletType: WalletType[walletType],
          amount: BigInt(amountCoins),
          ledgerType: LedgerEntryType.WITHDRAWAL,
          reference: idempotencyKey,
          idempotencyKey: `withdrawal_reserve:${idempotencyKey}`,
        },
        tx,
      );

      return tx.withdrawalRequest.create({
        data: {
          creatorId,
          walletType,
          amountMinor: amountCoins,
          currencyCode: quote.currencyCode,
          // Snapshot: what this withdrawal pays, and where, is fixed now.
          grossMinor: quote.grossMinor,
          feeMinor: quote.feeMinor,
          netMinor: quote.netMinor,
          rateMinorPer100Coins: quote.rateMinorPer100Coins,
          payoutTo: {
            provider: account.provider,
            bankName: account.bankName,
            accountLast4: account.accountLast4,
            accountName: account.accountName,
            recipientCode: account.recipientCode,
          },
          status: risk.needsReview ? 'PENDING_REVIEW' : 'APPROVED',
          riskFlags: risk.needsReview ? risk.reasons : undefined,
          idempotencyKey,
        },
      });
    }, EXTENDED_TX_OPTIONS);

    if (!risk.needsReview) {
      await this.processPayout(withdrawal.id);
    }

    return this.prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawal.id } });
  }

  async approve(withdrawalId: string, reviewerId: string, reviewerRoles: RoleName[]) {
    const withdrawal = await this.prisma.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    if (withdrawal.status !== 'PENDING_REVIEW') throw new BadRequestException('Not pending review');

    await this.prisma.withdrawalRequest.update({
      where: { id: withdrawalId },
      data: { status: 'APPROVED', decidedAt: new Date() },
    });
    await this.audit.record({
      actorId: reviewerId,
      actorRole: reviewerRoles[0],
      action: 'withdrawal.approve',
      targetType: 'withdrawal',
      targetId: withdrawalId,
    });

    const processed = await this.processPayout(withdrawalId);
    await this.notifyStatus(processed);
    return processed;
  }

  async reject(withdrawalId: string, reviewerId: string, reviewerRoles: RoleName[], reason: string) {
    const withdrawal = await this.prisma.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    if (withdrawal.status !== 'PENDING_REVIEW') throw new BadRequestException('Not pending review');

    // Release + status update commit together — same fix as request()
    // above and every other credit-then-write call site fixed today.
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.releaseReserve(withdrawal.creatorId, withdrawal.walletType, withdrawal.amountMinor, withdrawal.idempotencyKey, tx);
      return tx.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: { status: 'REJECTED', decidedAt: new Date(), failureReason: reason },
      });
    }, EXTENDED_TX_OPTIONS);

    await this.audit.record({
      actorId: reviewerId,
      actorRole: reviewerRoles[0],
      action: 'withdrawal.reject',
      targetType: 'withdrawal',
      targetId: withdrawalId,
      metadata: { reason },
    });

    await this.notifyStatus(updated);
    return updated;
  }

  // Tells the requester about a status change they didn't trigger
  // themselves (a reviewer's decision, the payout provider's confirmation).
  // Keyed per withdrawal+status so a webhook that fires twice, or a path
  // that reports the same outcome twice, notifies once.
  private notifyStatus(w: {
    id: string;
    creatorId: string;
    walletType: string;
    amountMinor: number;
    status: string;
    failureReason: string | null;
  }) {
    return this.notifications.notifyOnce(w.creatorId, 'WITHDRAWAL_UPDATE', `wd:${w.id}:${w.status}`, {
      withdrawalId: w.id,
      status: w.status,
      amountCoins: w.amountMinor,
      walletType: w.walletType,
      reason: w.status === 'FAILED' || w.status === 'REJECTED' ? (w.failureReason ?? undefined) : undefined,
    });
  }

  private async processPayout(withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId } });

    try {
      // Pays the NET cash figure snapshotted at request time to the saved
      // account (never coins, never today's rate).
      if (withdrawal.netMinor === null) throw new Error('This withdrawal has no payout amount recorded');
      const to = (withdrawal.payoutTo ?? {}) as { provider?: string; recipientCode?: string };
      const payout = await this.payoutProvider.initiatePayout({
        userId: withdrawal.creatorId,
        amountMinor: withdrawal.netMinor,
        currencyCode: withdrawal.currencyCode,
        idempotencyKey: withdrawal.idempotencyKey,
        recipientCode: to.recipientCode,
      });
      return this.prisma.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: {
          status: 'PROCESSING',
          payoutProvider: this.payoutProvider.constructor.name.toLowerCase().includes('paystack') ? 'paystack' : 'mock',
          providerRef: payout.providerRef,
        },
      });
    } catch (e: any) {
      this.logger.warn(`Payout for withdrawal ${withdrawalId} could not be started: ${e?.message ?? e}`);
      // Same fix — release and the FAILED status update commit together.
      const failed = await this.prisma.$transaction(async (tx) => {
        await this.releaseReserve(withdrawal.creatorId, withdrawal.walletType, withdrawal.amountMinor, withdrawal.idempotencyKey, tx);
        return tx.withdrawalRequest.update({
          where: { id: withdrawalId },
          data: { status: 'FAILED', failureReason: 'Payout initiation failed' },
        });
      }, EXTENDED_TX_OPTIONS);
      await this.notifyStatus(failed);
      return failed;
    }
  }

  // Called from the payout webhook — never from a client call.
  async confirmPaid(providerRef: string) {
    const withdrawal = await this.prisma.withdrawalRequest.findFirst({ where: { providerRef } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found for providerRef');
    if (withdrawal.status === 'PAID') return withdrawal; // idempotent
    const paid = await this.prisma.withdrawalRequest.update({ where: { id: withdrawal.id }, data: { status: 'PAID' } });
    await this.notifyStatus(paid);
    return paid;
  }

  async confirmFailed(providerRef: string, reason: string) {
    const withdrawal = await this.prisma.withdrawalRequest.findFirst({ where: { providerRef } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found for providerRef');
    if (withdrawal.status === 'FAILED') return withdrawal; // idempotent
    // Same fix — release and the FAILED status update commit together.
    const failed = await this.prisma.$transaction(async (tx) => {
      await this.releaseReserve(withdrawal.creatorId, withdrawal.walletType, withdrawal.amountMinor, withdrawal.idempotencyKey, tx);
      return tx.withdrawalRequest.update({
        where: { id: withdrawal.id },
        data: { status: 'FAILED', failureReason: reason },
      });
    }, EXTENDED_TX_OPTIONS);
    await this.notifyStatus(failed);
    return failed;
  }

  // The requester's own withdrawal history, newest first. Deliberately a
  // narrow projection: riskFlags (internal review reasons), providerRef and
  // payoutProvider are never sent to the person who made the request.
  // `amountCoins` is the amount in coins (the column is named amountMinor
  // for historical reasons but has always held coins).
  async listMine(userId: string, opts: { limit?: number; before?: string; walletType?: WithdrawableWallet } = {}) {
    const take = Math.min(Math.max(Math.floor(opts.limit ?? 20) || 20, 1), 50);

    let beforeDate: Date | undefined;
    if (opts.before) {
      beforeDate = new Date(opts.before);
      if (Number.isNaN(beforeDate.getTime())) throw new BadRequestException('before must be an ISO timestamp');
    }

    const rows = await this.prisma.withdrawalRequest.findMany({
      where: {
        creatorId: userId,
        ...(opts.walletType ? { walletType: opts.walletType } : {}),
        ...(beforeDate ? { requestedAt: { lt: beforeDate } } : {}),
      },
      orderBy: { requestedAt: 'desc' },
      take,
      select: {
        id: true,
        walletType: true,
        amountMinor: true,
        currencyCode: true,
        feeMinor: true,
        netMinor: true,
        payoutTo: true,
        status: true,
        requestedAt: true,
        decidedAt: true,
        failureReason: true,
      },
    });

    return rows.map((w) => ({
      id: w.id,
      walletType: w.walletType,
      amountCoins: w.amountMinor,
      currencyCode: w.currencyCode,
      // Cash after fees, and where it was sent. Never the recipient code.
      feeMinor: w.feeMinor,
      netMinor: w.netMinor,
      bankName: (w.payoutTo as any)?.bankName ?? null,
      accountLast4: (w.payoutTo as any)?.accountLast4 ?? null,
      status: w.status,
      requestedAt: w.requestedAt,
      decidedAt: w.decidedAt,
      // Only meaningful (and only shown) for terminal failures/rejections.
      failureReason: w.status === 'FAILED' || w.status === 'REJECTED' ? w.failureReason : null,
    }));
  }

  private async releaseReserve(
    creatorId: string,
    walletType: WalletType,
    amountCoins: number,
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ) {
    // A withdrawal row only ever holds one of the two withdrawable wallets
    // (request() validates it). If anything else somehow got stored, fail
    // loudly rather than credit a spendable wallet by mistake.
    if (walletType !== WalletType.CREATOR_EARNINGS && walletType !== WalletType.AGENCY_EARNINGS) {
      throw new Error(`Unexpected withdrawal wallet type: ${walletType}`);
    }
    await this.wallet.credit(
      {
        userId: creatorId,
        walletType,
        amount: BigInt(amountCoins),
        ledgerType: LedgerEntryType.WITHDRAWAL_RELEASE,
        reference: idempotencyKey,
        idempotencyKey: `withdrawal_release:${idempotencyKey}`,
      },
      tx,
    );
  }
}
