import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { reconcileWallet, WalletReconciliation } from './reconciliation-rules';
import { AuditService } from '../audit/audit.service';

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

  async checkWallet(walletId: string): Promise<WalletReconciliation> {
    const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    const sum = await this.prisma.ledgerEntry.aggregate({
      where: { walletId },
      _sum: { amount: true },
    });
    return reconcileWallet(walletId, wallet.balance, sum._sum.amount ?? 0n);
  }
}
