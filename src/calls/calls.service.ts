import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RTC_PROVIDER } from '../live/live.service';
import type { RtcProvider } from '../live/providers/rtc-provider.interface';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotBlocked } from '../common/blocks';
import { WalletService } from '../economy/wallet.service';
import { RevenueSplitService } from '../economy/revenue-split.service';
import { WalletType, LedgerEntryType, RoleName } from '@prisma/client';
import { HostLevelsService } from '../host-levels/host-levels.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class CallsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly wallet: WalletService,
    private readonly revenueSplit: RevenueSplitService,
    private readonly hostLevels: HostLevelsService,
    private readonly audit: AuditService,
  ) {}

  private async notifyMissed(call: { id: string; callerId: string; calleeId: string }) {
    const caller = await this.prisma.user.findUnique({ where: { id: call.callerId }, select: { displayName: true } });
    await this.notifications.notifyOnce(call.calleeId, 'MISSED_CALL', `missed:${call.id}`, {
      callId: call.id,
      callerId: call.callerId,
      callerDisplayName: caller?.displayName ?? null,
    });
  }

  // A call ringing longer than this without being answered auto-resolves
  // to MISSED the next time anything checks its status — see getStatus().
  // Not a cron job; checked lazily, same tradeoff as everywhere else in
  // this backend that treats "still real, just not instant" as an
  // acceptable honest choice over new scheduled-job infrastructure.
  private static readonly RING_TIMEOUT_MS = 45_000;

  async getPricing() {
    const config = await this.prisma.callPricingConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    return config ?? { id: 'default', pricePerMinute: 100, maxDurationMin: 60, active: true };
  }

  async updatePricing(body: any, actorId: string) {
    const pricePerMinute = Math.floor(Number(body.pricePerMinute));
    const maxDurationMin = Math.floor(Number(body.maxDurationMin));
    const active = body.active === undefined ? true : Boolean(body.active);
    if (!Number.isFinite(pricePerMinute) || pricePerMinute < 1 || pricePerMinute > 1_000_000) throw new BadRequestException('pricePerMinute must be between 1 and 1000000');
    if (!Number.isFinite(maxDurationMin) || maxDurationMin < 1 || maxDurationMin > 240) throw new BadRequestException('maxDurationMin must be between 1 and 240');
    const existing = await this.prisma.callPricingConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const config = existing
      ? await this.prisma.callPricingConfig.update({ where: { id: existing.id }, data: { pricePerMinute, maxDurationMin, active } })
      : await this.prisma.callPricingConfig.create({ data: { pricePerMinute, maxDurationMin, active } });
    await this.audit.record({ actorId, actorRole: 'SUPER_ADMIN' as RoleName, action: 'call_pricing.update', targetType: 'call_pricing', targetId: config.id, metadata: { pricePerMinute, maxDurationMin, active } });
    return config;
  }

  async initiate(callerId: string, calleeId: string) {
    if (callerId === calleeId) throw new BadRequestException("You can't call yourself");
    const callee = await this.prisma.user.findUnique({
      where: { id: calleeId },
      select: { id: true, oneOnOneEnabled: true, roles: { select: { role: true } } },
    });
    if (!callee) throw new NotFoundException('User not found');
    if (!callee.roles.some((r) => r.role === RoleName.CREATOR)) throw new ForbiddenException('1-on-1 is available to hosts only');
    await this.hostLevels.assertUnlock(calleeId, 'ONE_ON_ONE_VIDEO');
    if (!callee.oneOnOneEnabled) throw new ForbiddenException('This host is not currently accepting 1-on-1 requests');
    await assertNotBlocked(this.prisma, callerId, calleeId, "You can't call this user");

    const pricing = await this.getPricing();
    if (!pricing.active) throw new ForbiddenException('1-on-1 video is currently disabled');
    const balance = await this.wallet.getBalance(callerId, WalletType.COIN);
    if (balance < BigInt(pricing.pricePerMinute)) throw new BadRequestException(`You need at least ${pricing.pricePerMinute} coins to start this call`);

    const existingRinging = await this.prisma.call.findFirst({
      where: { callerId, calleeId, status: 'RINGING' },
    });
    if (existingRinging) return existingRinging;

    const { channelName } = await this.rtc.createChannel(`call-${Date.now()}`);
    const call = await this.prisma.call.create({
      data: { callerId, calleeId, providerChannel: channelName, pricePerMinute: pricing.pricePerMinute },
    });

    // The actual point of this whole feature — an instant signal to the
    // callee's socket, not something they'd only discover by polling.
    // Enriched with the caller's real display name (one extra lookup at
    // call-initiation time, not per-poll) so the incoming-call screen
    // shows a name instead of a raw id.
    const caller = await this.prisma.user.findUnique({ where: { id: callerId }, select: { displayName: true } });
    this.realtime.emitToUser(calleeId, 'call:incoming', { callId: call.id, callerId, callerDisplayName: caller?.displayName ?? null });

    return call;
  }

  // Real-time-first (the emit above), but this REST status check is
  // still the source of truth a client reconciles against — e.g. after
  // reconnecting, or if the socket event was missed for any reason.
  async getStatus(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();

    if (call.status === 'RINGING' && Date.now() - call.createdAt.getTime() > CallsService.RING_TIMEOUT_MS) {
      // Conditional on still RINGING, so two concurrent status checks can't
      // both "win" the transition and notify the callee twice.
      const flipped = await this.prisma.call.updateMany({
        where: { id: callId, status: 'RINGING' },
        data: { status: 'MISSED', endedAt: new Date() },
      });
      const missed = await this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
      if (flipped.count === 1) {
        this.realtime.emitToUser(call.callerId, 'call:missed', { callId });
        await this.notifyMissed(call);
      }
      return missed;
    }
    return call;
  }

  async accept(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.calleeId !== userId) throw new ForbiddenException('Only the callee can accept');
    if (call.status !== 'RINGING') throw new BadRequestException('This call is no longer ringing');
    const balance = await this.wallet.getBalance(call.callerId, WalletType.COIN);
    if (balance < BigInt(call.pricePerMinute)) throw new BadRequestException('The caller no longer has enough coins for the first minute');

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'ACCEPTED', startedAt: null },
    });
    this.realtime.emitToUser(call.callerId, 'call:accepted', { callId });
    return updated;
  }

  async decline(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.calleeId !== userId) throw new ForbiddenException('Only the callee can decline');
    if (call.status !== 'RINGING') throw new BadRequestException('This call is no longer ringing');

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'DECLINED', endedAt: new Date() },
    });
    this.realtime.emitToUser(call.callerId, 'call:declined', { callId });
    return updated;
  }

  async startBilling(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();
    if (call.status !== 'ACCEPTED') throw new BadRequestException('Call is not connected');
    if (call.startedAt) return call;
    const balance = await this.wallet.getBalance(call.callerId, WalletType.COIN);
    if (balance < BigInt(call.pricePerMinute)) {
      await this.end(callId, userId);
      throw new BadRequestException('The caller no longer has enough coins to start the session');
    }
    const updated = await this.prisma.call.updateMany({ where: { id: callId, status: 'ACCEPTED', startedAt: null }, data: { startedAt: new Date() } });
    return updated.count ? this.prisma.call.findUniqueOrThrow({ where: { id: callId } }) : this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }

  private async settleDueMinutes(call: any) {
    if (call.status !== 'ACCEPTED' || !call.startedAt) return call;
    const elapsedMs = Math.max(0, Date.now() - call.startedAt.getTime());
    const pricing = await this.getPricing();
    const dueMinutes = Math.min(Math.ceil(elapsedMs / 60_000), pricing.maxDurationMin);
    const additionalMinutes = Math.max(0, dueMinutes - call.billedMinutes);
    if (additionalMinutes <= 0) return call;
    const totalDue = additionalMinutes * call.pricePerMinute;
    const host = await this.prisma.user.findUniqueOrThrow({ where: { id: call.calleeId }, select: { countryCode: true } });
    const split = await this.revenueSplit.resolve(host.countryCode);
    const creatorShare = Math.floor((totalDue * split.creatorShareBps) / 10000);
    const platformShare = totalDue - creatorShare;
    return this.prisma.$transaction(async (tx) => {
      await this.wallet.debit({ userId: call.callerId, walletType: WalletType.COIN, amount: BigInt(totalDue), ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT, reference: call.id, idempotencyKey: `call:${call.id}:minutes:${dueMinutes}` }, tx);
      if (creatorShare > 0) await this.wallet.credit({ userId: call.calleeId, walletType: WalletType.CREATOR_EARNINGS, amount: BigInt(creatorShare), ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT, reference: call.id, idempotencyKey: `call:${call.id}:creator:${dueMinutes}` }, tx);
      if (platformShare > 0) await this.wallet.recordPlatformEntry({ ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT, amount: BigInt(platformShare), reference: call.id, idempotencyKey: `call:${call.id}:platform:${dueMinutes}` }, tx);
      return tx.call.update({ where: { id: call.id }, data: { billedMinutes: dueMinutes, totalCoins: { increment: totalDue } } });
    });
  }

  async bill(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();
    if (call.status !== 'ACCEPTED' || !call.startedAt) return call;
    try {
      const updated = await this.settleDueMinutes(call);
      const pricing = await this.getPricing();
      if (updated.billedMinutes >= pricing.maxDurationMin) return this.end(callId, userId, true);
      return updated;
    } catch (e) {
      if (e instanceof BadRequestException && /Insufficient balance/i.test(e.message)) {
        return this.end(callId, userId, true);
      }
      throw e;
    }
  }

  async end(callId: string, userId: string, skipBilling = false) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();
    if (call.status === 'ENDED' || call.status === 'DECLINED' || call.status === 'MISSED') return call;
    let finalCall = call;
    if (!skipBilling && call.status === 'ACCEPTED' && call.startedAt) {
      try { finalCall = await this.settleDueMinutes(call); } catch { /* insufficient balance: end without an unpaid partial minute */ }
    }

    await this.rtc.destroyChannel(finalCall.providerChannel);
    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
    this.realtime.emitToUser(otherUserId, 'call:ended', { callId });

    // The caller giving up while it was still ringing is a missed call from
    // the callee's side, whether or not the 45s timeout ever fired.
    if (call.status === 'RINGING' && userId === call.callerId) await this.notifyMissed(call);
    return updated;
  }

  // A real, fresh publish token for whichever side of the call this user
  // is on — same joinToken pattern LiveService/RoomsService already use.
  async history(userId: string) {
    const calls = await this.prisma.call.findMany({
      where: { OR: [{ callerId: userId }, { calleeId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const otherIds = Array.from(new Set(calls.map((c) => c.callerId === userId ? c.calleeId : c.callerId)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: otherIds } },
      select: { id: true, displayName: true, avatarUrl: true, countryCode: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return Promise.all(calls.map(async (call) => {
      const isCaller = call.callerId === userId;
      const other = byId.get(isCaller ? call.calleeId : call.callerId);
      const host = byId.get(call.calleeId);
      const split = host ? await this.revenueSplit.resolve(host.countryCode) : { creatorShareBps: 0 };
      return {
        ...call,
        direction: isCaller ? 'OUTGOING' : 'INCOMING',
        otherUser: other ?? { id: isCaller ? call.calleeId : call.callerId, displayName: null, avatarUrl: null },
        amountSpent: isCaller ? call.totalCoins : 0,
        amountEarned: !isCaller ? Math.floor((call.totalCoins * split.creatorShareBps) / 10000) : 0,
      };
    }));
  }

  async joinToken(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();
    const token = await this.rtc.generateToken(call.providerChannel, userId, 'host');
    return { call, token };
  }
}

