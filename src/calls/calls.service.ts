import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RTC_PROVIDER } from '../live/live.service';
import type { RtcProvider } from '../live/providers/rtc-provider.interface';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotBlocked } from '../common/blocks';
import { WalletService } from '../economy/wallet.service';
import { RevenueSplitService } from '../economy/revenue-split.service';
import { Prisma, WalletType, LedgerEntryType, RoleName, CallMediaType } from '@prisma/client';
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
    return config ?? { id: 'default', pricePerMinute: 100, audioPricePerMinute: null, maxDurationMin: 60, active: true, platformFeeBps: 4000 };
  }

  private static readonly MAX_HOST_PRICE = 1_000_000;

  // Calls with a feature each: voice and video unlock separately in Host Levels.
  private static featureFor(mediaType: CallMediaType) {
    return mediaType === CallMediaType.AUDIO
      ? { key: 'ONE_ON_ONE_AUDIO', label: 'voice calls' }
      : { key: 'ONE_ON_ONE_VIDEO', label: 'video calls' };
  }

  // What this host charges per minute: their own price if they set one, otherwise the admin default.
  private hostPriceFor(
    host: { videoCallPricePerMinute?: number | null; audioCallPricePerMinute?: number | null },
    pricing: { pricePerMinute: number; audioPricePerMinute?: number | null },
    mediaType: CallMediaType,
  ) {
    const own = mediaType === CallMediaType.AUDIO ? host.audioCallPricePerMinute : host.videoCallPricePerMinute;
    return own ?? this.priceFor(pricing, mediaType);
  }

  // What a caller sees BEFORE ringing someone: the host's prices and whether each kind is open.
  async hostPricing(hostId: string) {
    const [host, pricing, progress] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: hostId },
        select: { id: true, oneOnOneEnabled: true, videoCallPricePerMinute: true, audioCallPricePerMinute: true, roles: { select: { role: true } } },
      }),
      this.getPricing(),
      this.hostLevels.progress(hostId),
    ]);
    if (!host) throw new NotFoundException('User not found');
    const isHost = host.roles.some((r) => r.role === RoleName.CREATOR);
    const open = isHost && host.oneOnOneEnabled && pricing.active;
    return {
      hostId,
      maxDurationMin: pricing.maxDurationMin,
      audio: { available: open && progress.unlocks.includes('ONE_ON_ONE_AUDIO'), pricePerMinute: this.hostPriceFor(host, pricing, CallMediaType.AUDIO) },
      video: { available: open && progress.unlocks.includes('ONE_ON_ONE_VIDEO'), pricePerMinute: this.hostPriceFor(host, pricing, CallMediaType.VIDEO) },
    };
  }

  // The host's own settings screen: what they currently charge, the default they'd get otherwise,
  // and the cut the platform keeps.
  async myPricing(userId: string) {
    const [me, pricing] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { videoCallPricePerMinute: true, audioCallPricePerMinute: true } }),
      this.getPricing(),
    ]);
    return {
      audioPricePerMinute: me.audioCallPricePerMinute,
      videoPricePerMinute: me.videoCallPricePerMinute,
      defaultAudioPricePerMinute: this.priceFor(pricing, CallMediaType.AUDIO),
      defaultVideoPricePerMinute: this.priceFor(pricing, CallMediaType.VIDEO),
      platformFeeBps: pricing.platformFeeBps,
      maxPricePerMinute: CallsService.MAX_HOST_PRICE,
    };
  }

  // null/'' clears the host's own price (back to the default); undefined leaves it unchanged.
  async updateMyPricing(userId: string, body: { audioPricePerMinute?: unknown; videoPricePerMinute?: unknown }) {
    const creator = await this.prisma.userRole.findFirst({ where: { userId, role: RoleName.CREATOR } });
    if (!creator) throw new ForbiddenException('Only hosts can set call prices');
    const parse = (raw: unknown, name: string): number | null | undefined => {
      if (raw === undefined) return undefined;
      if (raw === null || raw === '') return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > CallsService.MAX_HOST_PRICE) throw new BadRequestException(`${name} must be a whole number between 1 and ${CallsService.MAX_HOST_PRICE}`);
      return n;
    };
    const audio = parse(body.audioPricePerMinute, 'Voice call price');
    const video = parse(body.videoPricePerMinute, 'Video call price');
    if (audio === undefined && video === undefined) throw new BadRequestException('Nothing to update');
    await this.prisma.user.update({
      where: { id: userId },
      data: { ...(audio !== undefined ? { audioCallPricePerMinute: audio } : {}), ...(video !== undefined ? { videoCallPricePerMinute: video } : {}) },
    });
    return this.myPricing(userId);
  }

  // Voice calls fall back to the video price until an admin sets their own.
  private priceFor(pricing: { pricePerMinute: number; audioPricePerMinute?: number | null }, mediaType: CallMediaType) {
    return mediaType === CallMediaType.AUDIO ? pricing.audioPricePerMinute ?? pricing.pricePerMinute : pricing.pricePerMinute;
  }

  async updatePricing(body: any, actorId: string) {
    const pricePerMinute = Math.floor(Number(body.pricePerMinute));
    const maxDurationMin = Math.floor(Number(body.maxDurationMin));
    const active = body.active === undefined ? true : Boolean(body.active);
    const audioRaw = body.audioPricePerMinute;
    // Platform cut of every call, in basis points (4000 = 40%). Capped at 90% so a host always earns something.
    const platformFeeBps = body.platformFeeBps === undefined || body.platformFeeBps === null || body.platformFeeBps === '' ? 4000 : Math.floor(Number(body.platformFeeBps));
    if (!Number.isFinite(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 9000) throw new BadRequestException('platformFeeBps must be between 0 and 9000 (0%–90%)');
    const audioPricePerMinute = audioRaw === undefined || audioRaw === null || audioRaw === '' ? null : Math.floor(Number(audioRaw));
    if (audioPricePerMinute !== null && (!Number.isFinite(audioPricePerMinute) || audioPricePerMinute < 1 || audioPricePerMinute > 1_000_000)) throw new BadRequestException('audioPricePerMinute must be between 1 and 1000000');
    if (!Number.isFinite(pricePerMinute) || pricePerMinute < 1 || pricePerMinute > 1_000_000) throw new BadRequestException('pricePerMinute must be between 1 and 1000000');
    if (!Number.isFinite(maxDurationMin) || maxDurationMin < 1 || maxDurationMin > 240) throw new BadRequestException('maxDurationMin must be between 1 and 240');
    const existing = await this.prisma.callPricingConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const config = existing
      ? await this.prisma.callPricingConfig.update({ where: { id: existing.id }, data: { pricePerMinute, audioPricePerMinute, maxDurationMin, active, platformFeeBps } })
      : await this.prisma.callPricingConfig.create({ data: { pricePerMinute, audioPricePerMinute, maxDurationMin, active, platformFeeBps } });
    await this.audit.record({ actorId, actorRole: 'SUPER_ADMIN' as RoleName, action: 'call_pricing.update', targetType: 'call_pricing', targetId: config.id, metadata: { pricePerMinute, audioPricePerMinute, maxDurationMin, active, platformFeeBps } });
    return config;
  }

  async initiate(callerId: string, calleeId: string, rawMediaType?: unknown) {
    const mediaType = rawMediaType === 'AUDIO' ? CallMediaType.AUDIO : CallMediaType.VIDEO;
    if (callerId === calleeId) throw new BadRequestException("You can't call yourself");
    const callee = await this.prisma.user.findUnique({
      where: { id: calleeId },
      select: { id: true, oneOnOneEnabled: true, videoCallPricePerMinute: true, audioCallPricePerMinute: true, roles: { select: { role: true } } },
    });
    if (!callee) throw new NotFoundException('User not found');
    if (!callee.roles.some((r) => r.role === RoleName.CREATOR)) throw new ForbiddenException('1-on-1 is available to hosts only');
    // Voice and video unlock separately (Host Levels: ONE_ON_ONE_AUDIO / ONE_ON_ONE_VIDEO). This used to
    // check the video unlock for voice calls too, so a voice call told people "Level 5" while the admin
    // had unlocked it at Level 3.
    const feature = CallsService.featureFor(mediaType);
    await this.hostLevels.assertUnlock(calleeId, feature.key, feature.label);
    if (!callee.oneOnOneEnabled) throw new ForbiddenException('This host is not currently accepting 1-on-1 requests');
    await assertNotBlocked(this.prisma, callerId, calleeId, "You can't call this user");

    const pricing = await this.getPricing();
    if (!pricing.active) throw new ForbiddenException('1-on-1 calls are currently disabled');
    const price = this.hostPriceFor(callee, pricing, mediaType);
    const balance = await this.wallet.getBalance(callerId, WalletType.COIN);
    if (balance < BigInt(price)) throw new BadRequestException(`You need at least ${price} coins to start this call`);

    const existingRinging = await this.prisma.call.findFirst({
      where: { callerId, calleeId, status: 'RINGING', mediaType },
    });
    if (existingRinging) return existingRinging;

    const { channelName } = await this.rtc.createChannel(`call-${Date.now()}`);
    const call = await this.prisma.call.create({
      data: { callerId, calleeId, providerChannel: channelName, pricePerMinute: price, mediaType, platformFeeBps: pricing.platformFeeBps },
    });

    // The actual point of this whole feature — an instant signal to the
    // callee's socket, not something they'd only discover by polling.
    // Enriched with the caller's real display name (one extra lookup at
    // call-initiation time, not per-poll) so the incoming-call screen
    // shows a name instead of a raw id.
    const caller = await this.prisma.user.findUnique({ where: { id: callerId }, select: { displayName: true } });
    this.realtime.emitToUser(calleeId, 'call:incoming', { callId: call.id, callerId, callerDisplayName: caller?.displayName ?? null, mediaType });

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
    const pricing = await this.getPricing();
    // Billing can be called concurrently by both clients, reconnect logic, or
    // an end-of-call request. The wallet ledger is idempotent, but that alone
    // is not enough: two callers could both observe the same billedMinutes and
    // each increment Call.totalCoins. Lock the call row and re-read it inside
    // the same transaction that performs the wallet movements.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Call" WHERE "id" = ${call.id} FOR UPDATE`);
      const current = await tx.call.findUnique({ where: { id: call.id } });
      if (!current || current.status !== 'ACCEPTED' || !current.startedAt) return current ?? call;

      const elapsedMs = Math.max(0, Date.now() - current.startedAt.getTime());
      const dueMinutes = Math.min(Math.ceil(elapsedMs / 60_000), pricing.maxDurationMin);
      const additionalMinutes = Math.max(0, dueMinutes - current.billedMinutes);
      if (additionalMinutes <= 0) return current;

      const totalDue = additionalMinutes * current.pricePerMinute;
      // Calls use their own fixed split, not the country gift split: the platform keeps
      // `platformFeeBps` (40% by default) because calls cost more to run; the host keeps the rest.
      const creatorShare = Math.floor((totalDue * (10000 - current.platformFeeBps)) / 10000);
      const platformShare = totalDue - creatorShare;

      await this.wallet.debit({ userId: current.callerId, walletType: WalletType.COIN, amount: BigInt(totalDue), ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT, reference: current.id, idempotencyKey: `call:${current.id}:minutes:${dueMinutes}` }, tx);
      if (creatorShare > 0) await this.wallet.credit({ userId: current.calleeId, walletType: WalletType.CREATOR_EARNINGS, amount: BigInt(creatorShare), ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT, reference: current.id, idempotencyKey: `call:${current.id}:creator:${dueMinutes}` }, tx);
      if (platformShare > 0) await this.wallet.recordPlatformEntry({ ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT, amount: BigInt(platformShare), reference: current.id, idempotencyKey: `call:${current.id}:platform:${dueMinutes}` }, tx);
      return tx.call.update({ where: { id: current.id }, data: { billedMinutes: dueMinutes, totalCoins: { increment: totalDue }, hostCoins: { increment: creatorShare } } });
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
      try {
        finalCall = await this.settleDueMinutes(call);
      } catch (e) {
        // Only insufficient caller funds should end the call without billing
        // the remaining minute. Any other failure (DB, ledger, transaction,
        // configuration, etc.) must surface so we do not silently end a paid
        // call while leaving creator/platform revenue unrecorded.
        if (e instanceof BadRequestException && /Insufficient balance/i.test(e.message)) {
          finalCall = call;
        } else {
          throw e;
        }
      }
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
      // Calls made before the 60/40 call split have no hostCoins recorded: fall back to the old country split.
      const legacy = call.hostCoins === 0 && call.totalCoins > 0;
      const split = legacy && host ? await this.revenueSplit.resolve(host.countryCode) : { creatorShareBps: 0 };
      return {
        ...call,
        direction: isCaller ? 'OUTGOING' : 'INCOMING',
        otherUser: other ?? { id: isCaller ? call.calleeId : call.callerId, displayName: null, avatarUrl: null },
        amountSpent: isCaller ? call.totalCoins : 0,
        amountEarned: !isCaller ? (legacy ? Math.floor((call.totalCoins * split.creatorShareBps) / 10000) : call.hostCoins) : 0,
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

