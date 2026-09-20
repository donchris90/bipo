import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RevenueSplitService, ResolvedSplit } from './revenue-split.service';
import { EXTENDED_TX_OPTIONS } from '../prisma/prisma-transaction-options';
import { WalletType, LedgerEntryType, ChatContext } from '@prisma/client';

// Pure and exported for the same reason as games/settlement.service.ts's
// isWinningSelection: this is money math, so it gets a direct unit test
// rather than only indirect coverage through send().
//
// Agency commission (spec §34) comes out of the creator's share, not the
// platform's — the platform's cut is fixed by RevenueSplitConfig regardless
// of whether the recipient has an agency. This is a deliberate design
// choice (an alternative would be the agency taking a cut of the platform
// share, or of the whole gift) made explicit here since the spec doesn't
// dictate it.
export function computeGiftSplit(
  coinAmount: number,
  split: ResolvedSplit,
  agencyCommissionBps = 0,
): { creatorShare: number; platformShare: number; agencyShare: number } {
  const totalCreatorPool = Math.floor((coinAmount * split.creatorShareBps) / 10000);
  const platformShare = coinAmount - totalCreatorPool; // remainder to platform — avoids rounding leaks from splitting 3 ways with floor()
  const agencyShare = agencyCommissionBps > 0 ? Math.floor((totalCreatorPool * agencyCommissionBps) / 10000) : 0;
  const creatorShare = totalCreatorPool - agencyShare;
  return { creatorShare, platformShare, agencyShare };
}

export interface SendGiftParams {
  senderId: string;
  recipientId: string;
  giftId: string;
  context?: ChatContext;
  contextId?: string;
  pkBattleId?: string; // if the gift is sent during an active PK battle
  idempotencyKey: string;
}

@Injectable()
export class GiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly revenueSplit: RevenueSplitService,
    // Optional so the money logic stays constructible (and unit-testable)
    // without the notification stack; in the running app it is always
    // injected. Never awaited for its result and never able to fail a gift.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // Backing for a gift-picker UI — before this, the only way a client
  // could know what to pass as giftId to POST /gifts/send was to already
  // know it, since nothing returned the catalog. Only active gifts, since
  // an inactive one would just 404 if someone tried to send it anyway.
  async catalog() {
    return this.prisma.gift.findMany({
      where: { active: true },
      orderBy: { coinPrice: 'asc' },
      select: { id: true, code: true, name: true, coinPrice: true, category: true },
    });
  }

  async send(params: SendGiftParams) {
    if (params.senderId === params.recipientId) {
      throw new BadRequestException('Cannot send a gift to yourself');
    }

    const existing = await this.prisma.giftTransaction.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (existing) return existing; // idempotent on retry

    const gift = await this.prisma.gift.findUnique({ where: { id: params.giftId } });
    if (!gift || !gift.active) throw new NotFoundException('Gift not available');

    const sender = await this.prisma.user.findUnique({ where: { id: params.senderId } });
    if (!sender) throw new NotFoundException('Sender not found');

    const split = await this.revenueSplit.resolve(sender.countryCode);
    const coinAmount = gift.coinPrice;

    // Agency commission lookup kept inline here (Prisma query, not an
    // AgenciesService import) for the same reason as the PK-score hook
    // below — avoids a circular dependency between Economy and Agencies.
    const membership = await this.prisma.agencyMembership.findFirst({
      where: { creatorId: params.recipientId, status: 'ACTIVE' },
    });
    const agency = membership ? await this.prisma.agency.findUnique({ where: { id: membership.agencyId } }) : null;

    const { creatorShare, platformShare, agencyShare } = computeGiftSplit(
      coinAmount,
      split,
      membership?.commissionBps ?? 0,
    );

    // Same fix as EntryService.place(): every wallet movement plus the
    // GiftTransaction record that justifies them must commit together.
    // Before this, a failure in giftTransaction.create() after the debit/
    // credits had already gone through would move real money with no
    // transaction record — the exact bug class found live in the game
    // entry flow, same shape here.
    const transaction = await this.prisma.$transaction(async (tx) => {
      // 1. Debit sender's coin wallet (checks sufficient balance).
      await this.wallet.debit(
        {
          userId: params.senderId,
          walletType: WalletType.COIN,
          amount: BigInt(coinAmount),
          ledgerType: LedgerEntryType.GIFT_SENT,
          reference: params.idempotencyKey,
          idempotencyKey: `gift_sent:${params.idempotencyKey}`,
        },
        tx,
      );

      // 2. Credit recipient's creator-earnings wallet with their share.
      if (creatorShare > 0) {
        await this.wallet.credit(
          {
            userId: params.recipientId,
            walletType: WalletType.CREATOR_EARNINGS,
            amount: BigInt(creatorShare),
            ledgerType: LedgerEntryType.GIFT_RECEIVED,
            reference: params.idempotencyKey,
            idempotencyKey: `gift_received:${params.idempotencyKey}`,
          },
          tx,
        );
      }

      // 3. Record the platform's share (not a user wallet — see LedgerEntry.walletId comment).
      if (platformShare > 0) {
        await this.wallet.recordPlatformEntry(
          {
            ledgerType: LedgerEntryType.GIFT_RECEIVED,
            amount: BigInt(platformShare),
            reference: params.idempotencyKey,
            idempotencyKey: `gift_platform:${params.idempotencyKey}`,
          },
          tx,
        );
      }

      // 3b. Credit the agency owner's commission, if the recipient has an
      // active agency membership. Comes out of the creator's pool (see
      // computeGiftSplit comment), so this doesn't change platformShare.
      if (agency && agencyShare > 0) {
        await this.wallet.credit(
          {
            userId: agency.ownerId,
            walletType: WalletType.AGENCY_EARNINGS,
            amount: BigInt(agencyShare),
            ledgerType: LedgerEntryType.AGENCY_COMMISSION,
            reference: params.idempotencyKey,
            idempotencyKey: `gift_agency:${params.idempotencyKey}`,
          },
          tx,
        );
      }

      return tx.giftTransaction.create({
        data: {
          senderId: params.senderId,
          recipientId: params.recipientId,
          giftId: gift.id,
          coinAmount,
          context: params.context,
          contextId: params.contextId,
          pkBattleId: params.pkBattleId,
          idempotencyKey: params.idempotencyKey,
        },
      });
    }, EXTENDED_TX_OPTIONS);

    // 4. If sent during an active PK battle, feed the score. Kept outside
    // the financial transaction above deliberately — a PK score is a
    // display/game-state concern, not money, and a failure here shouldn't
    // roll back a gift that has already legitimately happened. Kept inline
    // here (rather than a PKService import) to avoid a circular dependency
    // between Economy and PK — PK depends on gift data, not the reverse.
    if (params.pkBattleId) {
      await this.applyPkScore(params.pkBattleId, params.senderId, coinAmount);
    }

    // Only reached for a gift that was actually just made (an idempotent
    // replay returned early above), so a retry can't notify twice.
    void this.notifications?.notifyGift(
      params.recipientId,
      { id: sender.id, displayName: sender.displayName ?? null },
      coinAmount,
    );

    // Broadcasting the gift event to the live/room WebSocket channel happens
    // in the controller/gateway layer, which has access to the Socket.IO
    // server instance — this service stays transport-agnostic.
    return transaction;
  }

  private async applyPkScore(pkBattleId: string, senderId: string, coinAmount: number) {
    const battle = await this.prisma.pKBattle.findUnique({ where: { id: pkBattleId } });
    if (!battle || battle.status !== 'ACTIVE') return; // gift still counts financially even if PK isn't live

    const scoreConfig =
      (await this.prisma.pKScoreConfig.findFirst({ where: { active: true }, orderBy: { id: 'desc' } })) ??
      null;
    const coinsPerPoint = scoreConfig?.coinsPerPoint ?? 1;
    const points = BigInt(Math.floor(coinAmount / coinsPerPoint));
    if (points <= 0n) return;

    if (senderId === battle.challengerId) {
      await this.prisma.pKBattle.update({
        where: { id: battle.id },
        data: { scoreChallenger: { increment: points } },
      });
    } else if (senderId === battle.opponentId) {
      await this.prisma.pKBattle.update({
        where: { id: battle.id },
        data: { scoreOpponent: { increment: points } },
      });
    }
    // A gift from a third party (not a participant) during a PK does not
    // move either score — only participants' own audiences count per spec's
    // "users send gifts" framing of §16.
  }

  // The "Honor" leaderboard (reference app's top-recipients ranking) —
  // real gift totals from GiftTransaction, grouped by recipient over a
  // window, not a fabricated score. `period` maps to a lookback window
  // rather than a calendar-aligned bucket (no "since midnight in the
  // recipient's timezone" concept anywhere else in this codebase either),
  // same honest-approximation call as ReconciliationService's windows.
  // "Bag" — what a recipient has actually been given, aggregated by gift
  // type rather than a flat transaction log (a flat log could run into
  // the thousands for an active creator; "you have 12x Rose, 3x Crown"
  // is what an inventory view actually needs). Same groupBy + join
  // pattern as ranking() above.
  async received(userId: string) {
    const grouped = await this.prisma.giftTransaction.groupBy({
      by: ['giftId'],
      where: { recipientId: userId },
      _sum: { coinAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { coinAmount: 'desc' } },
    });
    if (grouped.length === 0) return [];

    const giftRows = await this.prisma.gift.findMany({
      where: { id: { in: grouped.map((g) => g.giftId) } },
      select: { id: true, name: true, code: true },
    });
    const byId = new Map(giftRows.map((g) => [g.id, g]));

    return grouped
      .map((g) => {
        const gift = byId.get(g.giftId);
        if (!gift) return null; // gift removed from the catalog since it was sent
        return {
          giftId: gift.id,
          giftName: gift.name,
          giftCode: gift.code,
          count: g._count._all,
          totalCoinValue: g._sum.coinAmount ?? 0,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  async ranking(period: 'today' | 'week', limit = 20) {
    const since = new Date(Date.now() - (period === 'today' ? 24 : 24 * 7) * 60 * 60 * 1000);

    const grouped = await this.prisma.giftTransaction.groupBy({
      by: ['recipientId'],
      where: { createdAt: { gte: since } },
      _sum: { coinAmount: true },
      orderBy: { _sum: { coinAmount: 'desc' } },
      take: limit,
    });
    if (grouped.length === 0) return [];

    const recipients = await this.prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.recipientId) } },
      select: { id: true, displayName: true, countryCode: true },
    });
    const byId = new Map(recipients.map((r) => [r.id, r]));

    return grouped
      .map((g) => {
        const user = byId.get(g.recipientId);
        if (!user) return null; // recipient deleted/deactivated since the gift was sent
        return {
          userId: user.id,
          displayName: user.displayName,
          countryCode: user.countryCode,
          honorScore: g._sum.coinAmount ?? 0,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }
}
