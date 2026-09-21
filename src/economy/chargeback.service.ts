import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

  // A coin purchase can have only one chargeback in RYDA's accounting model.
  // The purchase row is claimed atomically (CONFIRMED -> CHARGEBACK) before
  // the clawback is applied, and coinPurchaseId is also UNIQUE in the database.
  // This closes the race where two different provider webhook deliveries could
  // both pass an initial "no chargeback exists" read.
  //
  // The clawback deliberately uses a deterministic idempotency key derived from
  // the purchase itself, not the webhook/event id. Different webhook deliveries
  // for the same purchase must never create different wallet debits.
  async record(coinPurchaseId: string, reason: string | undefined, _providerEventKey?: string) {
    const existing = await this.prisma.chargeback.findUnique({ where: { coinPurchaseId } });
    if (existing) return existing;

    const purchase = await this.prisma.coinPurchase.findUnique({
      where: { id: coinPurchaseId },
      select: {
        id: true,
        userId: true,
        amountMinor: true,
        currencyCode: true,
        coinAmount: true,
        status: true,
      },
    });
    if (!purchase) throw new NotFoundException('Coin purchase not found');

    if (purchase.status === 'CHARGEBACK') {
      // This should only be reachable if an old database was populated before
      // the unique chargeback constraint existed. Do not debit coins again.
      const row = await this.prisma.chargeback.findUnique({ where: { coinPurchaseId } });
      if (row) return row;
      throw new BadRequestException('Purchase is already marked as charged back');
    }

    if (purchase.status !== 'CONFIRMED') {
      // A dispute against a payment that never credited coins must not create a
      // negative coin balance. Failed/pending/refunded purchases have nothing
      // in the coin wallet for this service to claw back.
      throw new BadRequestException('Only a confirmed coin purchase can be charged back');
    }

    return this.prisma.$transaction(async (tx) => {
      // Atomic claim. Under concurrent webhook delivery only one transaction
      // can change CONFIRMED -> CHARGEBACK; the loser must not touch the wallet.
      const claimed = await tx.coinPurchase.updateMany({
        where: { id: coinPurchaseId, status: 'CONFIRMED' },
        data: { status: 'CHARGEBACK' },
      });

      if (claimed.count === 0) {
        const existingInTx = await tx.chargeback.findUnique({ where: { coinPurchaseId } });
        if (existingInTx) return existingInTx;
        throw new BadRequestException('Coin purchase was already processed');
      }

      await this.wallet.forceDebit(
        {
          userId: purchase.userId,
          walletType: WalletType.COIN,
          amount: BigInt(purchase.coinAmount),
          ledgerType: LedgerEntryType.CHARGEBACK,
          reference: coinPurchaseId,
          // Stable per purchase: webhook replay with a different event id still
          // resolves to the same accounting movement.
          idempotencyKey: `chargeback:${coinPurchaseId}`,
        },
        tx,
      );

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
