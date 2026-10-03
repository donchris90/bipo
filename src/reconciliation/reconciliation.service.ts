import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { reconcileWallet, WalletReconciliation } from './reconciliation-rules';
import { AuditService } from '../audit/audit.service';
import { buildExpectedLedgerMovements, FinancialReconciliationResult, FinancialReconciliationIssue } from './financial-reconciliation';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Checks every wallet in the system. Fine for the current scale (one
  // query per wallet); if the wallet count grows large enough for this to
  // be slow, the fix is batching the ledger-sum query with a GROUP BY
  // rather than parallelizing more aggressively — this isn't the place to
  // add caching or approximation, since the whole point is an exact check.
  async checkAll(): Promise<{ checked: number; discrepancies: WalletReconciliation[] }> {
    const wallets = await this.prisma.wallet.findMany({ select: { id: true, balance: true } });

    const results = await Promise.all(
      wallets.map(async (w) => {
        const sum = await this.prisma.ledgerEntry.aggregate({
          where: { walletId: w.id },
          _sum: { amount: true },
        });
        return reconcileWallet(w.id, w.balance, sum._sum.amount ?? 0n);
      }),
    );

    return {
      checked: results.length,
      discrepancies: results.filter((r) => !r.ok),
    };
  }

  async runScheduledCheck() {
    const result = await this.checkAll();
    if (result.discrepancies.length === 0) return result;

    this.logger.error(`Wallet reconciliation found ${result.discrepancies.length} discrepancy(ies) across ${result.checked} wallet(s)`);
    for (const discrepancy of result.discrepancies) {
      await this.audit.record({
        action: 'finance.wallet_reconciliation_discrepancy',
        targetType: 'Wallet',
        targetId: discrepancy.walletId,
        metadata: {
          ledgerSum: discrepancy.ledgerSum.toString(),
          walletBalance: discrepancy.walletBalance.toString(),
          discrepancy: discrepancy.discrepancy.toString(),
          checkedWallets: result.checked,
        },
      });
    }
    return result;
  }

  // Source-record reconciliation catches a different class of drift than the
  // wallet sum check: a purchase/gift/withdrawal can have a matching wallet
  // balance but still be missing the ledger movement that explains it. This is
  // deliberately read-only; finance gets an issue list instead of an automatic
  // "repair" that could mint or destroy value.
  async checkFinancialLinks(limit = 5000): Promise<FinancialReconciliationResult> {
    const take = Math.min(Math.max(Math.floor(limit) || 5000, 1), 5000);
    const [gifts, purchases, chargebacks, withdrawals] = await Promise.all([
      this.prisma.giftTransaction.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, coinAmount: true, idempotencyKey: true, creatorShareCoins: true, platformShareCoins: true, agencyShareCoins: true, luckyRewardCoins: true },
      }),
      this.prisma.coinPurchase.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, status: true, coinAmount: true },
      }),
      this.prisma.chargeback.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, coinPurchaseId: true, coinAmount: true },
      }),
      this.prisma.withdrawalRequest.findMany({
        orderBy: { requestedAt: 'desc' },
        take,
        select: { id: true, idempotencyKey: true, status: true },
      }),
    ]);

    const sources = [
      ...gifts.map((data) => ({ category: 'GIFT' as const, data })),
      ...purchases.map((data) => ({ category: 'COIN_PURCHASE' as const, data })),
      ...chargebacks.map((data) => ({ category: 'CHARGEBACK' as const, data })),
      ...withdrawals.map((data) => ({ category: 'WITHDRAWAL' as const, data })),
    ];
    const expected = sources.flatMap((source) => buildExpectedLedgerMovements(source).map((movement) => ({ ...movement, source })));
    const ledgerByKey = new Map<string, any>();

    // Prisma/Postgres can have a practical parameter limit. Chunk the IN query
    // so a busy installation can still run reconciliation without one giant
    // SQL statement.
    for (let i = 0; i < expected.length; i += 500) {
      const chunk = expected.slice(i, i + 500);
      const rows = await this.prisma.ledgerEntry.findMany({
        where: { idempotencyKey: { in: chunk.map((item) => item.key) } },
        select: { idempotencyKey: true, amount: true },
      });
      for (const row of rows) ledgerByKey.set(row.idempotencyKey, row);
    }

    const issues: FinancialReconciliationIssue[] = [];
    for (const source of sources) {
      const expectedMovements = buildExpectedLedgerMovements(source);
      const missingLedgerKeys = expectedMovements.filter((movement) => !ledgerByKey.has(movement.key)).map((movement) => movement.key);
      const mismatchedLedgerEntries = expectedMovements
        .filter((movement) => ledgerByKey.has(movement.key))
        .map((movement) => ({ movement, actual: ledgerByKey.get(movement.key) }))
        .filter(({ movement, actual }) => BigInt(actual.amount) !== movement.amount)
        .map(({ movement, actual }) => ({
          key: movement.key,
          expectedAmount: movement.amount.toString(),
          actualAmount: BigInt(actual.amount).toString(),
        }));
      if (missingLedgerKeys.length === 0 && mismatchedLedgerEntries.length === 0) continue;

      const reference = source.category === 'CHARGEBACK'
        ? (source.data.coinPurchaseId ?? source.data.id)
        : source.data.id;
      const reason = source.category === 'GIFT' &&
        (source.data.creatorShareCoins == null || source.data.platformShareCoins == null || source.data.agencyShareCoins == null)
        ? 'Legacy gift is missing immutable split snapshots; verify the legacy row before relying on split reconciliation.'
        : 'Source record is missing or has an incorrectly valued ledger movement required by the current accounting contract.';

      issues.push({ category: source.category, reference, missingLedgerKeys, mismatchedLedgerEntries, reason });
    }

    return {
      checked: { gifts: gifts.length, coinPurchases: purchases.length, chargebacks: chargebacks.length, withdrawals: withdrawals.length },
      issueCount: issues.length,
      issues,
      legacySnapshotWarnings: gifts.filter((gift) => gift.creatorShareCoins == null || gift.platformShareCoins == null || gift.agencyShareCoins == null).length,
      truncated: [gifts, purchases, chargebacks, withdrawals].some((rows) => rows.length === take),
    };
  }

  async checkWallet(walletId: string): Promise<WalletReconciliation> {
    const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    const sum = await this.prisma.ledgerEntry.aggregate({
      where: { walletId },
      _sum: { amount: true },
    });
    return reconcileWallet(walletId, wallet.balance, sum._sum.amount ?? 0n);
  }
}
