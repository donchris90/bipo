import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { WalletType, LedgerEntryType } from '@prisma/client';

@Injectable()
export class ChargebackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  // Called from the payment webhook when the provider reports a dispute —
  // never from a client call, same as CoinPurchaseService.confirm.
  async record(coinPurchaseId: string, reason: string | undefined, idempotencyKey: string) {
    const existing = await this.prisma.chargeback.findFirst({ where: { coinPurchaseId } });
    if (existing) return existing; // idempotent — a provider can resend a dispute webhook

    const purchase = await this.prisma.coinPurchase.findUnique({ where: { id: coinPurchaseId } });
    if (!purchase) throw new NotFoundException('Coin purchase not found');

    // The clawback, the CoinPurchase status flip, and the Chargeback
    // record all commit together — same fix as everywhere else today.
    // This one matters more than most: forceDebit() is already the
    // dangerous, no-sufficient-funds-check path (see WalletService), so
    // leaving it un-transactional would mean a punitive clawback could
    // succeed while leaving no Chargeback row to explain why — an
    // accounting gap on top of an already-exceptional operation.
    return this.prisma.$transaction(async (tx) => {
      await this.wallet.forceDebit(
        {
          userId: purchase.userId,
          walletType: WalletType.COIN,
          amount: BigInt(purchase.coinAmount),
          ledgerType: LedgerEntryType.CHARGEBACK,
          reference: coinPurchaseId,
          idempotencyKey: `chargeback:${idempotencyKey}`,
        },
        tx,
      );

      await tx.coinPurchase.update({ where: { id: coinPurchaseId }, data: { status: 'CHARGEBACK' } });

      return tx.chargeback.create({
        data: {
          userId: purchase.userId,
          coinPurchaseId,
          amountMinor: purchase.amountMinor,
          currencyCode: purchase.currencyCode,
          coinAmount: purchase.coinAmount,
          reason,
        },
      });
    }, EXTENDED_TX_OPTIONS);
  }

  countForUser(userId: string): Promise<number> {
    return this.prisma.chargeback.count({ where: { userId } });
  }
}
