import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { C2COrderStatus, LedgerEntryType, WalletType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { AuditService } from '../audit/audit.service';

const DEFAULT_TTL_MINUTES = 30;

@Injectable()
export class C2CService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  async create(_buyerId: string, _coinAmount: number, _clientFiatAmountMinor: number | undefined, _clientCurrencyCode: string | undefined, _ttlMinutes = DEFAULT_TTL_MINUTES) {
    throw new BadRequestException('C2C coin trading is currently unavailable');
  }

  async listOpen(_buyerId: string) {
    return [];
  }

  async accept(orderId: string, sellerId: string) {
    await this.expireStale();
    const seller = await this.prisma.user.findUnique({ where: { id: sellerId }, select: { id: true, status: true, kycVerified: true } });
    if (!seller || seller.status !== 'ACTIVE') throw new ForbiddenException('Account is not active');
    if (!seller.kycVerified) throw new ForbiddenException('Seller KYC verification is required for C2C trading');
    const order = await this.prisma.c2COrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('C2C order not found');
    if (order.buyerId === sellerId) throw new BadRequestException('Buyer cannot accept their own order');
    if (order.status !== C2COrderStatus.OPEN || order.expiresAt <= new Date()) throw new BadRequestException('Order is no longer available');

    // Reserve seller coins atomically with the acceptance. A seller can never
    // accept an order without actually locking the coins needed to settle it.
    return this.prisma.$transaction(async tx => {
      const claimed = await tx.c2COrder.updateMany({ where: { id: orderId, status: C2COrderStatus.OPEN, sellerId: '' }, data: { sellerId, status: C2COrderStatus.ACCEPTED, acceptedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('Order was accepted by another seller');
      await this.wallet.debit({ userId: sellerId, walletType: WalletType.COIN, amount: BigInt(order.coinAmount), ledgerType: LedgerEntryType.C2C_ESCROW, reference: orderId, idempotencyKey: `c2c:escrow:${orderId}` }, tx);
      return tx.c2COrder.findUniqueOrThrow({ where: { id: orderId } });
    }, EXTENDED_TX_OPTIONS);
  }

  async submitPayment(buyerId: string, orderId: string, proofUrl?: string, note?: string, paymentReference?: string) {
    const order = await this.requireBuyer(orderId, buyerId);
    if (order.status !== C2COrderStatus.ACCEPTED) throw new BadRequestException('Order is not awaiting payment');
    if (!proofUrl && !paymentReference && !note) throw new BadRequestException('Payment proof or reference is required');
    if (proofUrl) {
      try {
        const u = new URL(proofUrl);
        if (u.protocol !== 'https:') throw new Error('unsafe');
      } catch { throw new BadRequestException('proofUrl must be a valid HTTPS URL'); }
    }
    if (paymentReference && !/^[A-Za-z0-9._:/-]{3,255}$/.test(paymentReference)) throw new BadRequestException('Invalid payment reference');
    return this.prisma.c2COrder.update({ where: { id: orderId }, data: { status: C2COrderStatus.PAYMENT_SUBMITTED, paymentProofUrl: proofUrl?.slice(0, 2048), paymentProofNote: note?.slice(0, 2000), paymentReference: paymentReference?.slice(0, 255), paidAt: new Date() } });
  }

  async release(sellerId: string, orderId: string) {
    const order = await this.prisma.c2COrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('C2C order not found');
    if (order.sellerId !== sellerId) throw new ForbiddenException('Only the seller can release this order');
    if (order.status !== C2COrderStatus.PAYMENT_SUBMITTED) throw new BadRequestException('Buyer payment is not marked submitted');

    const result = await this.prisma.$transaction(async tx => {
      const claimed = await tx.c2COrder.updateMany({ where: { id: orderId, status: C2COrderStatus.PAYMENT_SUBMITTED }, data: { status: C2COrderStatus.RELEASED, releasedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('Order is already settled');
      await this.wallet.credit({ userId: order.buyerId, walletType: WalletType.COIN, amount: BigInt(order.coinAmount), ledgerType: LedgerEntryType.C2C_RELEASE, reference: orderId, idempotencyKey: `c2c:release:${orderId}` }, tx);
      return tx.c2COrder.findUniqueOrThrow({ where: { id: orderId } });
    }, EXTENDED_TX_OPTIONS);
    return result;
  }

  async cancel(userId: string, orderId: string) {
    const order = await this.prisma.c2COrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('C2C order not found');
    if (order.buyerId !== userId && order.sellerId !== userId) throw new ForbiddenException('Not a participant in this order');
    if (!([C2COrderStatus.OPEN, C2COrderStatus.ACCEPTED] as C2COrderStatus[]).includes(order.status)) throw new BadRequestException('Order cannot be cancelled in its current state');

    return this.prisma.$transaction(async tx => {
      const claimed = await tx.c2COrder.updateMany({ where: { id: orderId, status: { in: [C2COrderStatus.OPEN, C2COrderStatus.ACCEPTED] } }, data: { status: C2COrderStatus.CANCELLED, cancelledAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('Order state changed; retry');
      if (order.status === C2COrderStatus.ACCEPTED && order.sellerId) {
        await this.wallet.credit({ userId: order.sellerId, walletType: WalletType.COIN, amount: BigInt(order.coinAmount), ledgerType: LedgerEntryType.C2C_REFUND, reference: orderId, idempotencyKey: `c2c:refund:${orderId}` }, tx);
      }
      return tx.c2COrder.findUniqueOrThrow({ where: { id: orderId } });
    }, EXTENDED_TX_OPTIONS);
  }

  async dispute(userId: string, orderId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Dispute reason is required');
    const order = await this.prisma.c2COrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('C2C order not found');
    if (order.buyerId !== userId && order.sellerId !== userId) throw new ForbiddenException('Not a participant in this order');
    if (!([C2COrderStatus.ACCEPTED, C2COrderStatus.PAYMENT_SUBMITTED] as C2COrderStatus[]).includes(order.status)) throw new BadRequestException('Order cannot be disputed in its current state');
    return this.prisma.c2COrder.update({ where: { id: orderId }, data: { status: C2COrderStatus.DISPUTED, disputeReason: reason.trim().slice(0, 2000), disputedAt: new Date() } });
  }

  async adminList(status?: C2COrderStatus) {
    return this.prisma.c2COrder.findMany({
      where: status ? { status } : { status: { in: [C2COrderStatus.DISPUTED, C2COrderStatus.PAYMENT_SUBMITTED, C2COrderStatus.ACCEPTED] } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  async adminResolve(orderId: string, adminId: string, action: 'RELEASE' | 'REFUND', note?: string) {
    const order = await this.prisma.c2COrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('C2C order not found');
    if (order.status !== C2COrderStatus.DISPUTED) throw new BadRequestException('Only disputed orders can be resolved');
    const result = await this.prisma.$transaction(async tx => {
      if (action === 'RELEASE') {
        await this.wallet.credit({ userId: order.buyerId, walletType: WalletType.COIN, amount: BigInt(order.coinAmount), ledgerType: LedgerEntryType.C2C_RELEASE, reference: orderId, idempotencyKey: `c2c:admin-release:${orderId}` }, tx);
        await tx.c2COrder.update({ where: { id: orderId }, data: { status: C2COrderStatus.RELEASED, resolvedAt: new Date(), adminNote: note?.slice(0, 2000) } });
      } else {
        await this.wallet.credit({ userId: order.sellerId, walletType: WalletType.COIN, amount: BigInt(order.coinAmount), ledgerType: LedgerEntryType.C2C_REFUND, reference: orderId, idempotencyKey: `c2c:admin-refund:${orderId}` }, tx);
        await tx.c2COrder.update({ where: { id: orderId }, data: { status: C2COrderStatus.REFUNDED, resolvedAt: new Date(), adminNote: note?.slice(0, 2000) } });
      }
      return tx.c2COrder.findUniqueOrThrow({ where: { id: orderId } });
    }, EXTENDED_TX_OPTIONS);
    await this.audit.record({ actorId: adminId, action: `c2c.${action.toLowerCase()}`, targetType: 'c2c_order', targetId: orderId, metadata: { note } });
    return result;
  }

  private async requireBuyer(orderId: string, buyerId: string) {
    const order = await this.prisma.c2COrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('C2C order not found');
    if (order.buyerId !== buyerId) throw new ForbiddenException('Only the buyer can update payment');
    return order;
  }

  async expireStaleOrders() {
    return this.expireStale();
  }

  private async expireStale() {
    const stale = await this.prisma.c2COrder.findMany({ where: { status: { in: [C2COrderStatus.OPEN, C2COrderStatus.ACCEPTED] }, expiresAt: { lte: new Date() } }, take: 100 });
    for (const order of stale) {
      await this.prisma.$transaction(async tx => {
        const claimed = await tx.c2COrder.updateMany({ where: { id: order.id, status: { in: [C2COrderStatus.OPEN, C2COrderStatus.ACCEPTED] } }, data: { status: C2COrderStatus.EXPIRED } });
        if (claimed.count === 1 && order.status === C2COrderStatus.ACCEPTED && order.sellerId) {
          await this.wallet.credit({ userId: order.sellerId, walletType: WalletType.COIN, amount: BigInt(order.coinAmount), ledgerType: LedgerEntryType.C2C_REFUND, reference: order.id, idempotencyKey: `c2c:expire-refund:${order.id}` }, tx);
        }
      }, EXTENDED_TX_OPTIONS);
    }
  }
}
