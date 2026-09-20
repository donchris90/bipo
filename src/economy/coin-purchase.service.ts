import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import type { PaymentProvider } from './providers/payment-provider.interface';
import { WalletType, LedgerEntryType } from '@prisma/client';

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

@Injectable()
export class CoinPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    private readonly notifications: NotificationsService,
  ) {}

  async initiate(userId: string, packageId: string, idempotencyKey: string) {
    const pkg = await this.prisma.coinPackage.findUnique({ where: { id: packageId } });
    if (!pkg || !pkg.active) throw new NotFoundException('Coin package not available');

    const existing = await this.prisma.coinPurchase.findUnique({ where: { idempotencyKey } });
    if (existing) return existing; // idempotent on retry

    const payment = await this.paymentProvider.createPayment({
      amountMinor: pkg.priceMinor,
      currencyCode: pkg.currencyCode,
      userId,
      idempotencyKey,
    });

    // The provider's payment page. This used to be thrown away, so there was no
    // way for the app to send anyone to pay — a purchase could be started but
    // never completed.
    return this.prisma.coinPurchase.create({
      data: {
        userId,
        packageId,
        provider: this.paymentProvider.constructor.name.toLowerCase().includes('paystack') ? 'paystack' : 'mock',
        providerRef: payment.providerRef,
        checkoutUrl: payment.redirectUrl ?? null,
        amountMinor: pkg.priceMinor,
        currencyCode: pkg.currencyCode,
        coinAmount: pkg.coinAmount,
        idempotencyKey,
        status: 'PENDING',
      },
    });
  }

  // The app polls this after sending the person to the payment page. It only
  // reports what the (signature-verified) webhook has recorded — nothing here
  // lets a client mark a purchase as paid.
  async statusFor(userId: string, purchaseId: string) {
    const p = await this.prisma.coinPurchase.findUnique({
      where: { id: purchaseId },
      select: { id: true, userId: true, status: true, coinAmount: true, confirmedAt: true },
    });
    if (!p || p.userId !== userId) throw new NotFoundException('Purchase not found');
    return { id: p.id, status: p.status, coinAmount: p.coinAmount, confirmedAt: p.confirmedAt };
  }

  // Called from the webhook handler, NEVER from a client-reported
  // "payment succeeded" call — spec §26/§94 non-negotiable.
  async confirm(providerRef: string) {
    const purchase = await this.prisma.coinPurchase.findFirst({ where: { providerRef } });
    if (!purchase) throw new NotFoundException('Purchase not found for providerRef');
    if (purchase.status === 'CONFIRMED') return purchase; // idempotent

    const verification = await this.paymentProvider.verifyPayment(providerRef);
    if (!verification.verified) {
      await this.prisma.coinPurchase.update({ where: { id: purchase.id }, data: { status: 'FAILED' } });
      throw new BadRequestException('Payment could not be verified');
    }

    // Credit and the CONFIRMED status update must commit together — same
    // fix as EntryService/GiftService/WithdrawalService. Before this, a
    // failure in the status update after a successful credit would leave
    // a purchase permanently stuck at PENDING despite the coins already
    // having landed — self-healing on retry (credit() is idempotent, so a
    // retried confirm() wouldn't double-credit), but a real window where
    // the purchase record and the wallet disagreed about what happened.
    const confirmed = await this.prisma.$transaction(async (tx) => {
      await this.wallet.credit(
        {
          userId: purchase.userId,
          walletType: WalletType.COIN,
          amount: BigInt(purchase.coinAmount),
          ledgerType: LedgerEntryType.COIN_PURCHASE,
          reference: purchase.id,
          idempotencyKey: `coin_purchase:${purchase.id}`, // stable — safe even if webhook fires twice
        },
        tx,
      );

      return tx.coinPurchase.update({
        where: { id: purchase.id },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
    }, EXTENDED_TX_OPTIONS);

    // After the commit, once per purchase even if the webhook fires twice.
    await this.notifications.notifyOnce(purchase.userId, 'COIN_PURCHASE', `purchase:${purchase.id}`, {
      purchaseId: purchase.id,
      coins: purchase.coinAmount,
    });

    return confirmed;
  }
}
