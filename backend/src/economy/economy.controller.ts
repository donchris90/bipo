import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UnavailablePaymentProvider, type PaymentProvider } from './providers/payment-provider.interface';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { v4 as uuid } from 'uuid';
import { WalletService } from './wallet.service';
import { CoinPurchaseService, PAYMENT_PROVIDER } from './coin-purchase.service';
import { GiftService } from './gift.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { WalletType, RoleName, ChatContext } from '@prisma/client';
import { formatMinorUnits } from '../config/currency.util';
import { RealtimeGateway } from '../realtime/realtime.gateway';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  async balances(@Req() req: AuthedRequest) {
    const [coin, earnings, bonus] = await Promise.all([
      this.wallet.getBalance(req.user.userId, WalletType.COIN),
      this.wallet.getBalance(req.user.userId, WalletType.CREATOR_EARNINGS),
      this.wallet.getBalance(req.user.userId, WalletType.BONUS),
    ]);
    return { coin: coin.toString(), creatorEarnings: earnings.toString(), bonus: bonus.toString() };
  }
}

@Controller('api/v1/coins')
@UseGuards(JwtAuthGuard)
export class CoinPurchaseController {
  constructor(
    private readonly coinPurchase: CoinPurchaseService,
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  // How coins can be paid for. Paystack (cards, bank transfer, USSD) is the live
  // provider; Stripe is listed as coming soon and cannot be chosen yet.
  @Get('payment-methods')
  async paymentMethods(@Req() req: AuthedRequest) {
    const region = await this.prisma.regionalConfig.findUnique({ where: { countryCode: req.user.countryCode.toUpperCase() } });
    const configured = Array.isArray(region?.paymentMethods) ? region.paymentMethods as string[] : [];
    const has = (id: string) => configured.includes(id);
    return [
      { id: 'PAYSTACK', name: 'Paystack', description: 'Card, bank transfer or USSD', available: has('PAYSTACK') && !(this.paymentProvider instanceof UnavailablePaymentProvider), comingSoon: false },
      { id: 'CRYPTO', name: 'Crypto', description: 'Pay with supported cryptocurrency', available: false, comingSoon: has('CRYPTO') },
      { id: 'C2C', name: 'C2C', description: 'Peer-to-peer coin purchase', available: false, comingSoon: has('C2C') },
    ];
  }

  // Status of one of the caller's own purchases (the app polls this after the
  // payment page closes).
  @Get('purchases/:id')
  purchaseStatus(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.coinPurchase.statusFor(req.user.userId, id);
  }

  @Get('packages')
  async packages(@Req() req: AuthedRequest) {
    const countryCode = req.user.countryCode.toUpperCase();
    const rows = await this.prisma.coinPackage.findMany({
      where: { countryCode, active: true },
      orderBy: { coinAmount: 'asc' },
    });
    return rows.map((p) => ({
      id: p.id,
      coinAmount: p.coinAmount,
      price: formatMinorUnits(p.priceMinor, p.currencyCode), // client-ready display string, not just the raw minor-unit integer
      priceMinor: p.priceMinor,
      currencyCode: p.currencyCode,
    }));
  }

  // Idempotency-Key should really come from the request header (spec §69);
  // accepting it in the body here for simplicity — move to a header +
  // interceptor once more endpoints need the same treatment.
  @Post('purchase')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  purchase(
    @Body('packageId') packageId: string,
    @Body('idempotencyKey') idempotencyKey: string,
    @Req() req: AuthedRequest,
  ) {
    return this.coinPurchase.initiate(req.user.userId, packageId, idempotencyKey ?? uuid());
  }
}

@Controller('api/v1/gifts')
@UseGuards(JwtAuthGuard)
export class GiftController {
  constructor(
    private readonly gifts: GiftService,
    private readonly realtime: RealtimeGateway,
    private readonly prisma: PrismaService,
  ) {}

  // The gift catalog — what a picker UI shows before the user taps one
  // and hits POST /gifts/send with its id. No mobile caller existed for
  // this at all until now; adding it is what makes the in-room Gift
  // button real rather than another placeholder.
  @Get()
  catalog() {
    return this.gifts.catalog();
  }

  // Home's "Honor" ranking banner reads this — real gift totals, see
  // GiftService.ranking for why the window is a lookback, not a
  // calendar-aligned bucket.
  @Get('ranking')
  ranking(@Query('period') period: string | undefined) {
    if (period !== undefined && period !== 'today' && period !== 'week') {
      throw new BadRequestException("period must be 'today' or 'week'");
    }
    return this.gifts.ranking(period ?? 'today');
  }

  @Get('received')
  received(@Req() req: AuthedRequest) {
    return this.gifts.received(req.user.userId);
  }

  // The backpack: gifts received, day by day (today first), with who sent them.
  @Get('backpack')
  backpack(@Query('days') days: string | undefined, @Req() req: AuthedRequest) {
    return this.gifts.backpack(req.user.userId, days ? Number(days) : 7);
  }

  @Post('send')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async send(
    @Body('recipientId') recipientId: string,
    @Body('giftId') giftId: string,
    @Body('context') context: ChatContext | undefined,
    @Body('contextId') contextId: string | undefined,
    @Body('pkBattleId') pkBattleId: string | undefined,
    @Body('idempotencyKey') idempotencyKey: string,
    @Req() req: AuthedRequest,
  ) {
    // Gifts can be tied to a live stream, a party room, or a video (a "tip").
    if (context !== undefined && context !== null && !['LIVE', 'ROOM', 'VIDEO'].includes(context as string)) {
      throw new BadRequestException("context must be 'LIVE', 'ROOM' or 'VIDEO'");
    }
    if (context === 'VIDEO') {
      const video = contextId ? await this.prisma.video.findUnique({ where: { id: contextId }, select: { creatorId: true, status: true, allowGifts: true } }) : null;
      if (!video || video.status !== 'PUBLISHED') throw new BadRequestException('That video is not available');
      if (video.creatorId !== recipientId) throw new BadRequestException('A video tip must go to the video\'s creator');
      if (!video.allowGifts) throw new BadRequestException('The creator has turned tips off for this video');
    }

    const transaction = await this.gifts.send({
      senderId: req.user.userId,
      recipientId,
      giftId,
      context,
      contextId,
      pkBattleId,
      idempotencyKey: idempotencyKey ?? uuid(),
    });

    // Was defined on the gateway but never actually called from
    // anywhere — a gift could be sent successfully and no one currently
    // in the room would ever see it happen in real time, despite the
    // broadcast plumbing existing. Only fires when the gift is actually
    // tied to a live room (context+contextId present); a gift sent
    // outside any room has nowhere to broadcast to.
    if ((context === 'LIVE' || context === 'ROOM') && contextId) {
      // Everything a screen needs to animate the gift from the sender to the
      // receiver (and label it) without another lookup.
      const [gift, people] = await Promise.all([
        this.prisma.gift.findUnique({ where: { id: giftId }, select: { name: true, icon: true } }),
        this.prisma.user.findMany({ where: { id: { in: [req.user.userId, recipientId] } }, select: { id: true, displayName: true, avatarUrl: true } }),
      ]);
      const sender = people.find((p) => p.id === req.user.userId);
      const recipient = people.find((p) => p.id === recipientId);
      this.realtime.broadcastGift(context, contextId, {
        id: transaction.id,
        senderId: req.user.userId,
        senderName: sender?.displayName ?? null,
        senderAvatarUrl: sender?.avatarUrl ?? null,
        recipientId,
        recipientName: recipient?.displayName ?? null,
        giftId,
        giftName: gift?.name ?? null,
        giftIcon: gift?.icon ?? null,
        coinAmount: transaction.coinAmount,
      });
    }

    // broadcastPkScore existed on the gateway but nothing ever called it —
    // PK score only ever updated in the database, forcing mobile to poll
    // GET /pk/:id every few seconds to notice a change. GiftService.send
    // already applied the score update (if any) before returning; re-read
    // the battle here rather than changing GiftService's return contract,
    // since send() also needs to keep working exactly as before for every
    // caller that isn't PK-related.
    if (pkBattleId) {
      const battle = await this.prisma.pKBattle.findUnique({ where: { id: pkBattleId } });
      if (battle && battle.status === 'ACTIVE') {
        this.realtime.broadcastPkScore(pkBattleId, {
          pkBattleId,
          scoreChallenger: battle.scoreChallenger.toString(),
          scoreOpponent: battle.scoreOpponent.toString(),
        });
      }
    }

    return transaction;
  }
}
