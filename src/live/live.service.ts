import { LiveMediaService } from './live-media.service';
import {
  BadRequestException,
  ForbiddenException,
  Optional,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import type { RtcProvider } from './providers/rtc-provider.interface';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { fetchChatHistory } from '../common/chat-history';
import { ModerationService } from '../moderation/moderation.service';
import { WalletService } from '../economy/wallet.service';
import { RevenueSplitService } from '../economy/revenue-split.service';
import { GifterService } from '../economy/gifter.service';
import { LedgerEntryType, WalletType } from '@prisma/client';
import { HostLevelsService } from '../host-levels/host-levels.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SeasonsService } from '../seasons/seasons.service';
import { announceToFollowersAndAgency } from '../common/friend-announce';
import {
  PRIVATE_ACCEPT_WINDOW_MS,
  PRIVATE_HOST_SHARE_BPS,
  PRIVATE_JOIN_WINDOW_MS,
  PRIVATE_LIVE_UNLOCK,
  PRIVATE_RATE_LIMITS,
  settleBlock,
  validateRateCard,
} from './private-live.pricing';

export const RTC_PROVIDER = 'RTC_PROVIDER';

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    private readonly featureFlags: FeatureFlagsService,
    private readonly realtime: RealtimeGateway,
    private readonly moderation: ModerationService,
    private readonly wallet: WalletService,
    private readonly revenueSplit: RevenueSplitService,
    private readonly gifters: GifterService,
    // Optional parameters must come last (TypeScript rejects a required one
    // after it; SWC let it through, ts-jest did not).
    @Optional() private readonly media?: LiveMediaService,
    @Optional() private readonly hostLevels?: HostLevelsService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly seasons?: SeasonsService,
  ) {}

  // Per-user like throttle: recent (timestamp, count) entries within the
  // window. In-memory, single-instance — same trade-off (and same
  // move-to-Redis note) as RealtimeGateway's chat rate limiter.
  private likeLog = new Map<string, { at: number; count: number }[]>();
  private readonly LIKE_WINDOW_MS = 10_000;
  private readonly LIKE_WINDOW_MAX = 100;
  private readonly LIKE_MAX_PER_REQUEST = 20;

  async findMine(hostId: string) {
    return this.prisma.liveSession.findFirst({
      where: { hostId, status: { in: ['SCHEDULED', 'LIVE'] } },
    });
  }

  // Only an https image URL is stored as a cover (it comes from our own image
  // upload); anything else is dropped rather than saved and rendered later.
  static cleanCoverUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const url = raw.trim();
    if (url.length === 0 || url.length > 500) return null;
    try {
      return new URL(url).protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }

  async create(
    hostId: string,
    title: string,
    category: string | undefined,
    countryCode: string,
    themeColor?: string,
    coverUrl?: string,
    dailyTargetCoins?: number,
    privacy: 'PUBLIC' | 'PRIVATE' = 'PUBLIC',
  ) {
    if (await this.featureFlags.isEnabled('DISABLE_LIVE')) {
      throw new ForbiddenException('Live streaming is temporarily disabled');
    }

    const region = await this.prisma.regionalConfig.findUnique({ where: { countryCode: countryCode.toUpperCase() } });
    if (!region?.active) {
      throw new ForbiddenException('Live streaming is not available in your country yet');
    }

    const existing = await this.prisma.liveSession.findFirst({
      where: { hostId, status: { in: ['SCHEDULED', 'LIVE'] } },
    });
    if (existing) throw new BadRequestException('You already have an active or scheduled live session');

    const sessionId = uuid();
    const normalizedDailyTarget = dailyTargetCoins == null ? 1000 : Math.round(Number(dailyTargetCoins));
    if (!Number.isFinite(normalizedDailyTarget) || normalizedDailyTarget < 0 || normalizedDailyTarget > 10_000_000) {
      throw new BadRequestException('Daily target must be between 0 and 10,000,000 coins');
    }

    const normalizedPrivacy = privacy === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC';
    if (normalizedPrivacy === 'PRIVATE') {
      if (this.hostLevels) await this.hostLevels.assertUnlock(hostId, PRIVATE_LIVE_UNLOCK, 'private 1-on-1 live');
      const host = await this.prisma.user.findUnique({ where: { id: hostId }, select: { oneOnOneEnabled: true } });
      if (!host?.oneOnOneEnabled) throw new ForbiddenException('Enable 1-on-1 availability in your profile before starting a private live');
      // Prices come from the host's saved rate card, not from this request.
      const packageCount = await this.prisma.privateRatePackage.count({ where: { hostId } });
      if (packageCount === 0) throw new BadRequestException('Set up your private session rates before going live in private');
    }

    const { channelName } = await this.rtc.createChannel(sessionId);

    const session = await this.prisma.liveSession.create({
      data: {
        id: sessionId,
        hostId,
        title,
        category,
        countryCode,
        // Only a real hex color is stored — anything else is silently
        // dropped rather than saved as garbage a client would have to
        // guard against when rendering it as a color later.
        themeColor: themeColor && /^#[0-9A-Fa-f]{6}$/.test(themeColor) ? themeColor : null,
        dailyTargetCoins: normalizedDailyTarget,
        coverUrl: LiveService.cleanCoverUrl(coverUrl),
        privacy: normalizedPrivacy,
        providerChannel: channelName,
        status: 'LIVE',
        startedAt: new Date(),
      },
    });

    const token = await this.rtc.generateToken(channelName, hostId, 'host');

    if (this.notifications) {
      const host = await this.prisma.user.findUnique({ where: { id: hostId }, select: { displayName: true, avatarUrl: true } });
      void announceToFollowersAndAgency(this.prisma, this.notifications, hostId, 'FOLLOWED_HOST_LIVE', {
        hostId, hostDisplayName: host?.displayName ?? null, avatarUrl: host?.avatarUrl ?? null, sessionId, title,
      }, this.realtime);
    }

    return { session, token };
  }

  async joinToken(sessionId: string, userId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'LIVE') throw new NotFoundException('Live session not found or not active');

    if (await this.moderation.isBanned('LIVE', sessionId, userId)) {
      throw new ForbiddenException('You are banned from this live');
    }

    let rtcRole: 'host' | 'publisher' | 'audience' = 'audience';
    if (session.hostId === userId) {
      rtcRole = 'host';
    } else if (session.privacy === 'PRIVATE') {
      const request = await this.prisma.privateLiveRequest.findFirst({
        where: {
          sessionId,
          viewerId: userId,
          status: { in: ['ACCEPTED', 'ACTIVE'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!request) throw new ForbiddenException('This is a paid private live. Request access and wait for the host to accept you.');

      if (request.endsAt && request.endsAt.getTime() <= Date.now()) {
        await this.finish(session);
        throw new ForbiddenException('The paid private session has ended');
      }

      if (request.status === 'ACCEPTED' && request.acceptedAt && Date.now() - request.acceptedAt.getTime() > PRIVATE_JOIN_WINDOW_MS) {
        await this.refundPrivateRequest(request.id, request.viewerId, request.priceCoins, 'Viewer did not join in time', 'EXPIRED');
        throw new ForbiddenException('You took too long to join. Your coins were refunded.');
      }

      rtcRole = 'publisher'; // private 1-on-1 viewer must be able to publish video/audio
      if (request.status === 'ACCEPTED') {
        await this.startPrivateRequest(request.id, session);
      }
    }

    const token = await this.rtc.generateToken(session.providerChannel, userId, rtcRole);
    if (session.hostId !== userId) {
      await this.trackViewerJoin(sessionId, userId);
    }

    // Everything the viewer's header needs in the same round trip: who the
    // host really is (the screen used to show the stream title and a letter
    // as the "host"), whether I already follow them, and the live count.
    const [host, follow, viewerCount, entrance] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: session.hostId }, select: { id: true, displayName: true, avatarUrl: true } }),
      session.hostId === userId
        ? Promise.resolve(null)
        : this.prisma.follow.findUnique({
            where: { followerId_followingId: { followerId: userId, followingId: session.hostId } },
            select: { followerId: true },
          }),
      this.prisma.liveViewer.count({ where: { sessionId, leftAt: null } }),
      session.hostId === userId ? Promise.resolve(null) : this.gifters.entrance(userId).catch(() => null),
    ]);

    // VIP entrance is an ephemeral live-room event. It is deliberately not stored in chat
    // history: reconnecting viewers should not replay old entrance banners.
    if (entrance?.vip) {
      this.realtime.broadcastLiveEntrance(sessionId, {
        userId,
        displayName: entrance.displayName,
        avatarUrl: entrance.avatarUrl,
        tier: entrance.tier,
        level: entrance.level,
        message: `${entrance.displayName ?? 'A VIP'} entered the live`,
      });
    }

    return {
      session,
      token,
      private: session.privacy === 'PRIVATE',
      host: host ?? { id: session.hostId, displayName: null, avatarUrl: null },
      isFollowing: !!follow,
      viewerCount,
    };
  }


  // ── Private session rates (the host's saved rate card) ──────────────────────

  private async hostIsLive(hostId: string): Promise<boolean> {
    const live = await this.prisma.liveSession.findFirst({
      where: { hostId, status: { in: ['SCHEDULED', 'LIVE'] } },
      select: { id: true },
    });
    return !!live;
  }

  async getMyRateCard(hostId: string) {
    const [packages, live] = await Promise.all([
      this.prisma.privateRatePackage.findMany({
        where: { hostId },
        orderBy: { minutes: 'asc' },
        select: { id: true, minutes: true, priceCoins: true, description: true },
      }),
      this.hostIsLive(hostId),
    ]);
    return { packages, editable: !live, hostShareBps: PRIVATE_HOST_SHARE_BPS, limits: PRIVATE_RATE_LIMITS };
  }

  // What a viewer sees on the join sheet and on the host's profile.
  async getHostRateCard(hostId: string) {
    const packages = await this.prisma.privateRatePackage.findMany({
      where: { hostId },
      orderBy: { minutes: 'asc' },
      select: { id: true, minutes: true, priceCoins: true, description: true },
    });
    return { hostId, packages };
  }

  // Replaces the host's whole card. Only allowed while the host is not live, so a viewer can never
  // see a price change in the middle of a session.
  async saveMyRateCard(hostId: string, input: unknown) {
    if (await this.hostIsLive(hostId)) {
      throw new ForbiddenException('You can only edit your private session rates when you are not live.');
    }
    if (this.hostLevels) await this.hostLevels.assertUnlock(hostId, PRIVATE_LIVE_UNLOCK, 'private 1-on-1 live');
    const result = validateRateCard(input);
    if (!result.ok) throw new BadRequestException(result.error);
    await this.prisma.$transaction([
      this.prisma.privateRatePackage.deleteMany({ where: { hostId } }),
      ...result.packages.map((p) =>
        this.prisma.privateRatePackage.create({ data: { hostId, minutes: p.minutes, priceCoins: p.priceCoins, description: p.description } }),
      ),
    ]);
    return this.getMyRateCard(hostId);
  }

  // ── Paid private 1-on-1 live ────────────────────────────────────────────────
  // Lifecycle of one purchase (PrivateLiveRequest):
  //   PENDING  viewer paid the package price in full; host has 45s to accept
  //   ACCEPTED host said yes; the viewer has 60s to join (otherwise refunded, slot reopens)
  //   ACTIVE   viewer joined, the clock is running (renewals add more ACTIVE blocks)
  //   COMPLETED settled when the session is over: host paid 60% of what was delivered
  //   DECLINED / EXPIRED / REFUNDED  never started, viewer got everything back

  async requestPrivateAccess(sessionId: string, viewerId: string, packageId?: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'LIVE') throw new NotFoundException('Live session not found or not active');
    if (session.privacy !== 'PRIVATE') throw new BadRequestException('This live is not private');
    if (session.hostId === viewerId) throw new BadRequestException('The host cannot request their own private live');
    const host = await this.prisma.user.findUnique({ where: { id: session.hostId }, select: { oneOnOneEnabled: true } });
    if (!host?.oneOnOneEnabled) throw new ForbiddenException('This host is not currently accepting 1-on-1 requests');

    const existing = await this.prisma.privateLiveRequest.findFirst({
      where: { sessionId, viewerId, status: { in: ['PENDING', 'ACCEPTED', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    // Someone else is already in (or about to join) this private session. Say so before charging.
    const occupied = await this.prisma.privateLiveRequest.findFirst({
      where: { sessionId, viewerId: { not: viewerId }, status: { in: ['ACCEPTED', 'ACTIVE'] } },
      select: { id: true },
    });
    if (occupied) throw new BadRequestException('The host is in a private session right now. Try again when it ends.');

    if (!packageId) throw new BadRequestException('Choose a package first');
    const pkg = await this.prisma.privateRatePackage.findFirst({ where: { id: packageId, hostId: session.hostId } });
    if (!pkg) throw new BadRequestException('That package is no longer available. Please pick again.');

    const requestId = uuid();
    await this.prisma.$transaction(async (tx) => {
      await this.wallet.debit({
        userId: viewerId,
        walletType: WalletType.COIN,
        amount: BigInt(pkg.priceCoins),
        ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT,
        reference: requestId,
        idempotencyKey: `private_live_debit:${requestId}`,
      }, tx);

      await tx.privateLiveRequest.create({
        data: {
          id: requestId,
          sessionId,
          viewerId,
          // Price and length are copied onto the request: this is exactly what was charged.
          priceCoins: pkg.priceCoins,
          durationSeconds: pkg.minutes * 60,
          packageId: pkg.id,
          status: 'PENDING',
        },
      });
    });

    return this.getPrivateRequest(requestId, viewerId);
  }

  // Viewer buys another block from the host's rate card while the session is running. The new
  // time is added to the END of the current time, so nobody is kicked out and nothing is lost.
  async renewPrivateSession(sessionId: string, viewerId: string, packageId?: string) {
    if (!packageId) throw new BadRequestException('Choose a package first');
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "LiveSession" WHERE "id" = ${sessionId} FOR UPDATE
      `;
      if (!locked[0]) throw new NotFoundException('Live session not found');
      const session = await tx.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
      if (session.status !== 'LIVE' || session.privacy !== 'PRIVATE') {
        throw new BadRequestException('This private session is no longer running');
      }

      const current = await tx.privateLiveRequest.findFirst({
        where: { sessionId, viewerId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });
      if (!current || !current.endsAt) throw new ForbiddenException('You do not have a running private session to extend');

      const now = Date.now();
      const endsAtMs = current.endsAt.getTime();
      if (endsAtMs <= now) throw new BadRequestException('Your time has run out. The session is over.');

      const pkg = await tx.privateRatePackage.findFirst({ where: { id: packageId, hostId: session.hostId } });
      if (!pkg) throw new BadRequestException('That package is no longer available. Please pick again.');

      const remainingSeconds = Math.ceil((endsAtMs - now) / 1000);
      if (remainingSeconds + pkg.minutes * 60 > PRIVATE_RATE_LIMITS.maxSessionMinutes * 60) {
        throw new BadRequestException(`A session can last at most ${PRIVATE_RATE_LIMITS.maxSessionMinutes / 60} hours`);
      }

      const requestId = uuid();
      const newEndsAt = new Date(endsAtMs + pkg.minutes * 60_000);
      await this.wallet.debit({
        userId: viewerId,
        walletType: WalletType.COIN,
        amount: BigInt(pkg.priceCoins),
        ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT,
        reference: requestId,
        idempotencyKey: `private_live_debit:${requestId}`,
      }, tx);

      const block = await tx.privateLiveRequest.create({
        data: {
          id: requestId,
          sessionId,
          viewerId,
          priceCoins: pkg.priceCoins,
          durationSeconds: pkg.minutes * 60,
          packageId: pkg.id,
          parentRequestId: current.parentRequestId ?? current.id,
          status: 'ACTIVE',
          acceptedAt: new Date(now),
          startedAt: new Date(now),
          blockStartsAt: current.endsAt,
          endsAt: newEndsAt,
        },
      });
      await tx.liveSession.update({ where: { id: sessionId }, data: { privateEndsAt: newEndsAt } });
      return block;
    });
  }

  async getPrivateRequest(requestId: string, actorId: string) {
    const request = await this.prisma.privateLiveRequest.findUnique({
      where: { id: requestId },
      include: { session: true, viewer: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    if (!request) throw new NotFoundException('Private live request not found');
    if (request.session.hostId !== actorId && request.viewerId !== actorId) {
      throw new ForbiddenException('You are not part of this private request');
    }
    return request;
  }

  async listPrivateRequests(sessionId: string, hostId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId }, select: { hostId: true, privacy: true } });
    if (!session) throw new NotFoundException('Live session not found');
    if (session.hostId !== hostId) throw new ForbiddenException('Only the host can view private requests');
    if (session.privacy !== 'PRIVATE') throw new BadRequestException('This live is not private');

    return this.prisma.privateLiveRequest.findMany({
      where: { sessionId, status: { in: ['PENDING', 'ACCEPTED', 'ACTIVE'] } },
      orderBy: { createdAt: 'asc' },
      include: { viewer: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
  }

  async acceptPrivateRequest(requestId: string, hostId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Lock the live-session row so two accept taps/requests cannot both
      // observe an empty ACCEPTED/ACTIVE slot and approve two viewers.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "LiveSession" WHERE "id" = (
          SELECT "sessionId" FROM "PrivateLiveRequest" WHERE "id" = ${requestId}
        ) FOR UPDATE
      `;
      if (!locked[0]) throw new NotFoundException('Private live request not found');

      const request = await tx.privateLiveRequest.findUnique({
        where: { id: requestId },
        include: { session: true },
      });
      if (!request) throw new NotFoundException('Private live request not found');
      if (request.session.hostId !== hostId) throw new ForbiddenException('Only the host can accept the request');
      if (request.session.status !== 'LIVE') throw new BadRequestException('This live session is no longer active');
      if (request.session.privacy !== 'PRIVATE') throw new BadRequestException('This live is not private');
      if (request.status !== 'PENDING') throw new BadRequestException('This request is no longer pending');
      if (Date.now() - request.createdAt.getTime() > PRIVATE_ACCEPT_WINDOW_MS) {
        throw new BadRequestException('This request has expired and the viewer is being refunded');
      }

      const occupied = await tx.privateLiveRequest.findFirst({
        where: {
          sessionId: request.sessionId,
          status: { in: ['ACCEPTED', 'ACTIVE'] },
          id: { not: request.id },
        },
      });
      if (occupied) throw new BadRequestException('Another private viewer is already active or accepted');

      return tx.privateLiveRequest.update({
        where: { id: requestId },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
    });
  }

  async declinePrivateRequest(requestId: string, hostId: string) {
    const request = await this.prisma.privateLiveRequest.findUnique({
      where: { id: requestId },
      include: { session: true },
    });
    if (!request) throw new NotFoundException('Private live request not found');
    if (request.session.hostId !== hostId) throw new ForbiddenException('Only the host can decline the request');
    if (request.status !== 'PENDING' && request.status !== 'ACCEPTED') {
      throw new BadRequestException('This request can no longer be declined');
    }

    return this.refundPrivateRequest(request.id, request.viewerId, request.priceCoins, 'Host declined private live request', 'DECLINED');
  }

  // The viewer joined: the clock starts now. Nothing is paid out here; the host is paid when the
  // session is over (settlePrivateBlocks).
  private async startPrivateRequest(requestId: string, session: { id: string }) {
    const request = await this.prisma.privateLiveRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Private live request not found');
    if (request.status === 'ACTIVE') return request;
    if (request.status !== 'ACCEPTED') throw new ForbiddenException('Private access has not been accepted');

    const now = new Date();
    const endsAt = new Date(now.getTime() + request.durationSeconds * 1000);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.privateLiveRequest.updateMany({
        where: { id: requestId, status: 'ACCEPTED' },
        data: { status: 'ACTIVE', startedAt: now, blockStartsAt: now, endsAt },
      });
      if (updated.count > 0) {
        await tx.liveSession.update({
          where: { id: session.id },
          data: { privateStartedAt: now, privateEndsAt: endsAt },
        });
      }
      return tx.privateLiveRequest.findUniqueOrThrow({ where: { id: requestId } });
    });
  }

  // Gives the viewer everything back for a request that never became a running session.
  // Atomic: the status claim and the refund happen in one transaction, and only once.
  private async refundPrivateRequest(
    requestId: string,
    viewerId: string,
    priceCoins: number,
    reason: string,
    finalStatus: 'REFUNDED' | 'DECLINED' | 'EXPIRED' = 'REFUNDED',
  ) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.privateLiveRequest.updateMany({
        where: { id: requestId, status: { in: ['PENDING', 'ACCEPTED'] } },
        data: { status: finalStatus, refundedAt: now, refundedCoins: priceCoins, settleReason: reason },
      });
      if (claimed.count === 0) return tx.privateLiveRequest.findUnique({ where: { id: requestId } });
      await this.wallet.credit({
        userId: viewerId,
        walletType: WalletType.COIN,
        amount: BigInt(priceCoins),
        ledgerType: LedgerEntryType.REFUND,
        reference: requestId,
        idempotencyKey: `private_live_refund:${requestId}`,
      }, tx);
      return tx.privateLiveRequest.findUnique({ where: { id: requestId } });
    });
  }

  // Runs when a private session is over. Pays the host and refunds unused time, block by block:
  //  - viewer ended it  -> no refund; the host is paid for every purchased block in full
  //  - host ended it / dropped / time ran out -> unused minutes are refunded at each block's own
  //    per-minute rate; the host gets 60% of what was actually delivered, the platform 40%
  // Each block is claimed atomically, so running this twice can never pay anyone twice.
  private async settlePrivateBlocks(sessionId: string, hostId: string, viewerLeft: boolean) {
    const blocks = await this.prisma.privateLiveRequest.findMany({
      where: { sessionId, status: 'ACTIVE', settledAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (blocks.length === 0) return;
    const nowMs = Date.now();
    let deliveredMinutes = 0;

    for (const block of blocks) {
      const start = block.blockStartsAt ?? block.startedAt;
      if (!start) continue;
      const result = settleBlock({
        priceCoins: block.priceCoins,
        durationSeconds: block.durationSeconds,
        blockStartsAtMs: start.getTime(),
        nowMs,
        viewerLeft,
      });
      const settledAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.privateLiveRequest.updateMany({
          where: { id: block.id, status: 'ACTIVE', settledAt: null },
          data: {
            status: 'COMPLETED',
            settledAt,
            hostCoins: result.hostCoins,
            refundedCoins: result.refundCoins,
            refundedAt: result.refundCoins > 0 ? settledAt : null,
            settleReason: viewerLeft ? 'VIEWER_LEFT' : result.refundCoins > 0 ? 'ENDED_EARLY' : 'TIME_UP',
          },
        });
        if (claimed.count === 0) return;

        if (result.refundCoins > 0) {
          await this.wallet.credit({
            userId: block.viewerId,
            walletType: WalletType.COIN,
            amount: BigInt(result.refundCoins),
            ledgerType: LedgerEntryType.REFUND,
            reference: block.id,
            idempotencyKey: `private_live_unused_refund:${block.id}`,
          }, tx);
        }
        if (result.hostCoins > 0) {
          await this.wallet.credit({
            userId: hostId,
            walletType: WalletType.CREATOR_EARNINGS,
            amount: BigInt(result.hostCoins),
            ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT,
            reference: block.id,
            idempotencyKey: `private_live_creator:${block.id}`,
          }, tx);
        }
        if (result.platformCoins > 0) {
          await this.wallet.recordPlatformEntry({
            ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT,
            amount: BigInt(result.platformCoins),
            reference: block.id,
            idempotencyKey: `private_live_platform:${block.id}`,
          }, tx);
        }
      });
      deliveredMinutes += Math.floor(result.deliveredSeconds / 60);
    }

    if (this.hostLevels && deliveredMinutes > 0) {
      try { await this.hostLevels.awardRule(hostId, 'PRIVATE_MINUTE', deliveredMinutes); } catch { /* progression must never block private billing */ }
    }
  }

  async sweepPrivateSessions() {
    const now = new Date();
    // Requests are paid upfront, so a request that sits unanswered must not hold the viewer's
    // coins: expire and refund pending requests after 45 seconds...
    const pendingCutoff = new Date(now.getTime() - PRIVATE_ACCEPT_WINDOW_MS);
    const staleRequests = await this.prisma.privateLiveRequest.findMany({
      where: { status: 'PENDING', createdAt: { lte: pendingCutoff } },
      select: { id: true, viewerId: true, priceCoins: true },
      take: 100,
    });
    for (const request of staleRequests) {
      await this.refundPrivateRequest(request.id, request.viewerId, request.priceCoins, 'Private live request expired', 'EXPIRED');
    }

    // ...and an accepted viewer who never joins must not block the host's live for everyone else.
    // After 60 seconds the slot reopens and they are refunded.
    const joinCutoff = new Date(now.getTime() - PRIVATE_JOIN_WINDOW_MS);
    const noShows = await this.prisma.privateLiveRequest.findMany({
      where: { status: 'ACCEPTED', acceptedAt: { lte: joinCutoff } },
      select: { id: true, viewerId: true, priceCoins: true },
      take: 100,
    });
    for (const request of noShows) {
      await this.refundPrivateRequest(request.id, request.viewerId, request.priceCoins, 'Viewer did not join in time', 'EXPIRED');
    }

    const expired = await this.prisma.liveSession.findMany({
      where: { status: 'LIVE', privacy: 'PRIVATE', privateEndsAt: { lte: now } },
      select: { id: true },
      take: 100,
    });
    for (const s of expired) await this.endAbandoned(s.id);
    return expired.map((s) => s.id);
  }

  async privateStatus(sessionId: string, actorId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Live session not found');
    const isHost = session.hostId === actorId;
    const request = await this.prisma.privateLiveRequest.findFirst({
      where: {
        sessionId,
        status: { in: ['PENDING', 'ACCEPTED', 'ACTIVE'] },
        ...(isHost ? {} : { viewerId: actorId }),
      },
      orderBy: { createdAt: 'desc' },
      include: { viewer: { select: { id: true, displayName: true, avatarUrl: true } } },
    });

    let packages: { id: string; minutes: number; priceCoins: number; description: string | null }[] = [];
    let occupied = false;
    let outcome: { status: string; reason: string | null; refundedCoins: number } | null = null;
    if (session.privacy === 'PRIVATE') {
      packages = await this.prisma.privateRatePackage.findMany({
        where: { hostId: session.hostId },
        orderBy: { minutes: 'asc' },
        select: { id: true, minutes: true, priceCoins: true, description: true },
      });
      if (!isHost) {
        const other = await this.prisma.privateLiveRequest.findFirst({
          where: { sessionId, viewerId: { not: actorId }, status: { in: ['ACCEPTED', 'ACTIVE'] } },
          select: { id: true },
        });
        occupied = !!other;
        if (!request) {
          // Tell a viewer why their last request went nowhere (declined / timed out / no-show).
          const last = await this.prisma.privateLiveRequest.findFirst({
            where: {
              sessionId,
              viewerId: actorId,
              status: { in: ['DECLINED', 'EXPIRED', 'REFUNDED'] },
              createdAt: { gte: new Date(Date.now() - 5 * 60_000) },
            },
            orderBy: { createdAt: 'desc' },
            select: { status: true, settleReason: true, refundedCoins: true },
          });
          if (last) outcome = { status: last.status, reason: last.settleReason, refundedCoins: last.refundedCoins };
        }
      }
    }

    return {
      session: {
        id: session.id,
        status: session.status,
        privacy: session.privacy,
        privateStartedAt: session.privateStartedAt,
        privateEndsAt: session.privateEndsAt,
      },
      packages,
      hostShareBps: PRIVATE_HOST_SHARE_BPS,
      occupied,
      outcome,
      request,
    };
  }

  async end(sessionId: string, hostId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Live session not found');
    if (session.hostId !== hostId) throw new ForbiddenException('Only the host can end this session');
    return this.finish(session);
  }

  // Ends a session whose host has gone away. Same result as the host ending it.
  async endAbandoned(sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session) return null;
    return this.finish(session);
  }

  // Idempotent: ending a session that already ended returns it untouched, so a
  // repeated tap (or the sweeper racing the host) can't overwrite the real end
  // time and duration.
  private async finish(
    session: {
      id: string;
      hostId: string;
      providerChannel: string;
      status: string;
      startedAt: Date | null;
    },
    opts: { viewerLeft?: boolean } = {},
  ) {
    if (session.status === 'ENDED') {
      return this.prisma.liveSession.findUniqueOrThrow({ where: { id: session.id } });
    }
    // A video being shared in this live ends with it.
    this.media?.clear(session.id);

    // Pay the host / refund unused time for a running private session. This goes first: if it
    // fails nothing else has changed, the live stays open and the next sweep retries it.
    await this.settlePrivateBlocks(session.id, session.hostId, !!opts.viewerLeft);

    await this.rtc.destroyChannel(session.providerChannel);

    // Paid requests that never became a running private session are refunded in full.
    const unpaid = await this.prisma.privateLiveRequest.findMany({
      where: { sessionId: session.id, status: { in: ['PENDING', 'ACCEPTED'] } },
      select: { id: true, viewerId: true, priceCoins: true },
    });
    for (const request of unpaid) {
      await this.refundPrivateRequest(request.id, request.viewerId, request.priceCoins, 'Private live ended before access started', 'REFUNDED');
    }
    // Close all open viewer rows — the session is over.
    await this.prisma.liveViewer.updateMany({
      where: { sessionId: session.id, leftAt: null },
      data: { leftAt: new Date() },
    });

    const endedAt = new Date();
    const durationSeconds = session.startedAt
      ? Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000))
      : 0;

    const ended = await this.prisma.liveSession.update({
      where: { id: session.id },
      data: { status: 'ENDED', endedAt, durationSeconds },
    });

    if (this.seasons) {
      // Hosting is a core Rryda activity. Award a bounded Season signal at session end;
      // the season layer is best-effort and must never block ending the live.
      void this.seasons.contributePoints(session.hostId, Math.min(70, 10 + Math.floor(durationSeconds / 300)));
    }

    if (this.hostLevels && durationSeconds >= 60) {
      try { await this.hostLevels.awardRule(session.hostId, 'LIVE_MINUTE', Math.floor(durationSeconds / 60)); } catch { /* progression must never block ending a live */ }
    }

    // Viewers used to sit on a frozen picture: nothing told them it was over.
    try {
      this.realtime.broadcastLiveEnded(session.id, { sessionId: session.id, hostId: session.hostId });
    } catch {
      /* viewers also find out when their next join/refetch fails */
    }
    return ended;
  }

  // The public "who's live" list, hottest first (most people watching now),
  // with what a list card needs: host name/photo, live viewer count, and
  // whether the host is in a PK right now.
  async listLive() {
    const sessions = await this.prisma.liveSession.findMany({
      where: { status: 'LIVE', privacy: 'PUBLIC' },
      orderBy: { startedAt: 'desc' },
      take: 100,
      select: {
        id: true, hostId: true, title: true, category: true, coverUrl: true,
        themeColor: true, status: true, startedAt: true, endedAt: true, durationSeconds: true,
      },
    });
    if (sessions.length === 0) return [];
    const ids = sessions.map((s) => s.id);
    const hostIds = sessions.map((s) => s.hostId);
    const [hosts, counts, battles] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: hostIds } }, select: { id: true, displayName: true, avatarUrl: true } }),
      this.prisma.liveViewer.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids }, leftAt: null }, _count: { _all: true } }),
      this.prisma.pKBattle.findMany({
        where: { status: { in: ['COUNTDOWN', 'ACTIVE'] }, OR: [{ challengerId: { in: hostIds } }, { opponentId: { in: hostIds } }] },
        select: { challengerId: true, opponentId: true },
      }),
    ]);
    const hostById = new Map(hosts.map((h) => [h.id, h]));
    const countBySession = new Map(counts.map((c) => [c.sessionId, c._count._all]));
    const inPk = new Set(battles.flatMap((b) => [b.challengerId, b.opponentId]));
    return sessions
      .map((s) => ({
        ...s,
        hostDisplayName: hostById.get(s.hostId)?.displayName ?? null,
        hostAvatarUrl: hostById.get(s.hostId)?.avatarUrl ?? null,
        viewerCount: countBySession.get(s.id) ?? 0,
        inPk: inPk.has(s.hostId),
      }))
      .sort((a, b) => b.viewerCount - a.viewerCount || (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
      .slice(0, 50);
  }

  // Real watch history — built from LiveViewer rows that trackViewerJoin
  // has been writing since the join flow first called it, not a new
  // tracking mechanism. One row per session watched (not per join, in
  // case of multiple visits to the same session — most-recent visit
  // wins for ordering). No direct LiveSession->User relation exists for
  // the host, so the host's displayName is a manual batch lookup, same
  // pattern as GiftService.ranking().
  async findMyWatchHistory(userId: string, limit = 50) {
    const viewed = await this.prisma.liveViewer.findMany({
      where: { userId },
      orderBy: { joinedAt: 'desc' },
      take: limit,
      select: { sessionId: true, joinedAt: true },
    });
    if (viewed.length === 0) return [];

    // Collapse to one entry per session (most recent visit), preserving
    // recency order — a session watched multiple times shouldn't crowd
    // out other distinct sessions in the history list.
    const seen = new Set<string>();
    const distinct = viewed.filter((v) => (seen.has(v.sessionId) ? false : (seen.add(v.sessionId), true)));

    const sessions = await this.prisma.liveSession.findMany({
      where: { id: { in: distinct.map((v) => v.sessionId) } },
      select: { id: true, title: true, hostId: true, status: true },
    });
    const sessionById = new Map(sessions.map((s) => [s.id, s]));

    const hosts = await this.prisma.user.findMany({
      where: { id: { in: sessions.map((s) => s.hostId) } },
      select: { id: true, displayName: true },
    });
    const hostById = new Map(hosts.map((h) => [h.id, h]));

    return distinct
      .map((v) => {
        const session = sessionById.get(v.sessionId);
        if (!session) return null; // session deleted since being watched
        const host = hostById.get(session.hostId);
        return {
          sessionId: session.id,
          title: session.title,
          hostDisplayName: host?.displayName ?? null,
          status: session.status,
          watchedAt: v.joinedAt,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  // ── Viewer tracking ────────────────────────────────────────────

  async trackViewerJoin(sessionId: string, userId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: { id: true, hostId: true, status: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.status !== 'LIVE') {
      throw new BadRequestException('Session is not live');
    }
    if (await this.moderation.isBanned('LIVE', sessionId, userId)) {
      throw new ForbiddenException('You are banned from this live');
    }

    // The host is not a viewer of their own session.
    if (session.hostId === userId) return null;

    // Reuse an existing open row on rejoin (network blip, app reopened)
    // instead of creating a duplicate.
    const existing = await this.prisma.liveViewer.findFirst({
      where: { sessionId, userId, leftAt: null },
    });
    if (existing) return existing;

    const created = await this.prisma.liveViewer.create({
      data: { sessionId, userId },
    });
    await this.publishViewerCount(sessionId);
    return created;
  }

  async trackViewerLeave(sessionId: string, userId: string) {
    // In a paid private live the viewer leaving ends the session (no refund for unused time).
    // A viewer who was accepted but has not joined yet is not "in session", so it stays open.
    const live = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (live && live.status === 'LIVE' && live.privacy === 'PRIVATE' && live.hostId !== userId) {
      const running = await this.prisma.privateLiveRequest.findFirst({
        where: { sessionId, viewerId: userId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (running) {
        await this.finish(live, { viewerLeft: true });
        return null;
      }
    }

    const open = await this.prisma.liveViewer.findFirst({
      where: { sessionId, userId, leftAt: null },
    });
    if (!open) return null;

    const updated = await this.prisma.liveViewer.update({
      where: { id: open.id },
      data: { leftAt: new Date() },
    });
    await this.publishViewerCount(sessionId);
    return updated;
  }

  // Reaper: viewers whose app died never call /leave, so their row stayed
  // open and the viewer count only ever went up. Closes the rows of anyone
  // who has no socket in the live's room any more, then republishes the
  // count. `present` is the set of user ids with a socket in LIVE:<id>.
  async closeAbsentViewers(sessionId: string, present: Set<string>, openSince: Date) {
    const open = await this.prisma.liveViewer.findMany({
      where: { sessionId, leftAt: null, joinedAt: { lte: openSince } },
      select: { id: true, userId: true },
    });
    const gone = open.filter((v) => !present.has(v.userId)).map((v) => v.id);
    if (gone.length === 0) return 0;
    await this.prisma.liveViewer.updateMany({ where: { id: { in: gone }, leftAt: null }, data: { leftAt: new Date() } });
    await this.publishViewerCount(sessionId);
    return gone.length;
  }

  // Recounts open viewer rows, ratchets peakViewerCount up if this is a new
  // high (the updateMany's `lt` guard makes concurrent joins safe — the
  // peak can only ever move upward), and pushes the new count to everyone
  // in the session's socket room. A broadcast failure must never fail the
  // join/leave that triggered it.
  private async publishViewerCount(sessionId: string): Promise<number> {
    const viewerCount = await this.prisma.liveViewer.count({ where: { sessionId, leftAt: null } });
    await this.prisma.liveSession.updateMany({
      where: { id: sessionId, peakViewerCount: { lt: viewerCount } },
      data: { peakViewerCount: viewerCount },
    });
    try {
      this.realtime.broadcastLiveViewerCount(sessionId, { sessionId, viewerCount });
    } catch {
      /* socket layer unavailable — REST summary remains the source of truth */
    }
    return viewerCount;
  }

  // ── Likes, summary, chat history ────────────────────────────────

  async like(sessionId: string, userId: string, count?: number) {
    // Likes are how an audience shows appreciation; a host can't like their own stream.
    const owner = await this.prisma.liveSession.findUnique({ where: { id: sessionId }, select: { hostId: true } });
    if (owner && owner.hostId === userId) throw new ForbiddenException("You can't like your own live");
    const n = Math.min(Math.max(Math.floor(Number(count)) || 1, 1), this.LIKE_MAX_PER_REQUEST);

    const now = Date.now();
    const recent = (this.likeLog.get(userId) ?? []).filter((e) => now - e.at < this.LIKE_WINDOW_MS);
    const used = recent.reduce((sum, e) => sum + e.count, 0);
    if (used + n > this.LIKE_WINDOW_MAX) {
      this.likeLog.set(userId, recent);
      throw new HttpException('Too many likes, slow down', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push({ at: now, count: n });
    this.likeLog.set(userId, recent);

    // Atomic increment guarded on status — a like can't land on a session
    // that ended between the client's tap and this request.
    const result = await this.prisma.liveSession.updateMany({
      where: { id: sessionId, status: 'LIVE' },
      data: { likeCount: { increment: n } },
    });
    if (result.count === 0) throw new NotFoundException('Live session not found or not active');

    const updated = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: { likeCount: true },
    });
    const likeCount = updated?.likeCount ?? 0;

    try {
      this.realtime.broadcastLiveLike(sessionId, { sessionId, likeCount, count: n, userId });
    } catch {
      /* see publishViewerCount */
    }
    return { likeCount };
  }

  async summary(sessionId: string) {
    const s = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('Live session not found');

    const isLive = s.status === 'LIVE';
    const viewerCount = isLive ? await this.prisma.liveViewer.count({ where: { sessionId, leftAt: null } }) : 0;

    // Distinct people who ever joined — the "total viewers" a host's
    // end-of-stream summary shows (peak is tracked separately).
    const distinct = await this.prisma.liveViewer.findMany({
      where: { sessionId },
      distinct: ['userId'],
      select: { userId: true },
    });

    const elapsed =
      isLive && s.startedAt ? Math.max(0, Math.round((Date.now() - s.startedAt.getTime()) / 1000)) : null;

    // What this broadcast actually earned the host. Gifts sent inside the
    // session carry its id as their context; followers are people who followed
    // the host while the session was running.
    const giftWhere = { recipientId: s.hostId, context: 'LIVE' as const, contextId: sessionId };
    const followEnd = s.endedAt ?? new Date();
    const [giftAgg, topGifterRows, newFollowers] = await Promise.all([
      this.prisma.giftTransaction.aggregate({ where: giftWhere, _count: { _all: true }, _sum: { coinAmount: true } }),
      this.prisma.giftTransaction.groupBy({
        by: ['senderId'],
        where: giftWhere,
        _sum: { coinAmount: true },
        orderBy: { _sum: { coinAmount: 'desc' } },
        take: 3,
      }),
      s.startedAt
        ? this.prisma.follow.count({ where: { followingId: s.hostId, createdAt: { gte: s.startedAt, lte: followEnd } } })
        : Promise.resolve(0),
    ]);
    const gifters = topGifterRows.length
      ? await this.prisma.user.findMany({
          where: { id: { in: topGifterRows.map((g) => g.senderId) } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const gifterById = new Map(gifters.map((u) => [u.id, u]));

    return {
      id: s.id,
      hostId: s.hostId,
      title: s.title,
      category: s.category,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      likeCount: s.likeCount,
      viewerCount,
      peakViewerCount: s.peakViewerCount,
      totalViewerCount: distinct.length,
      durationSeconds: s.durationSeconds ?? elapsed,
      giftCount: giftAgg._count._all,
      // Gross coins senders paid for gifts sent to the host during this session.
      giftCoins: giftAgg._sum.coinAmount ?? 0,
      newFollowers,
      topGifters: topGifterRows.map((g) => ({
        userId: g.senderId,
        displayName: gifterById.get(g.senderId)?.displayName ?? null,
        avatarUrl: gifterById.get(g.senderId)?.avatarUrl ?? null,
        coins: g._sum.coinAmount ?? 0,
      })),
    };
  }

  async chatHistory(sessionId: string, limit?: number, before?: string) {
    const exists = await this.prisma.liveSession.findUnique({ where: { id: sessionId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Live session not found');
    return fetchChatHistory(this.prisma, 'LIVE', sessionId, { limit, before });
  }

  private async assertLiveHost(sessionId: string, actorId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Live session not found');
    if (session.hostId !== actorId) throw new ForbiddenException('Only the host can moderate viewers');
    if (session.status !== 'LIVE') throw new BadRequestException('Live session is not active');
    return session;
  }

  private async assertLiveHostOrModerator(sessionId: string, actorId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Live session not found');
    if (session.status !== 'LIVE') throw new BadRequestException('Live session is not active');
    if (session.hostId === actorId) return session;
    const mod = await this.prisma.liveModerator.findUnique({ where: { sessionId_userId: { sessionId, userId: actorId } } });
    if (!mod) throw new ForbiddenException('Requires host or moderator');
    return session;
  }

  private async logLiveModeration(
    actorId: string,
    actionType: 'KICK' | 'MUTE' | 'UNMUTE' | 'BAN' | 'UNBAN' | 'ADD_MODERATOR' | 'REMOVE_MODERATOR',
    sessionId: string,
    targetUserId: string,
  ) {
    await this.prisma.moderationAction.create({
      data: { actorId, actionType, context: 'LIVE', contextId: sessionId, targetUserId },
    });
  }

  private emitLiveModeration(
    sessionId: string,
    action: 'KICK' | 'MUTE' | 'UNMUTE' | 'BAN' | 'UNBAN',
    actorId: string,
    targetUserId: string,
  ) {
    try {
      this.realtime.broadcastLiveModeration(sessionId, { sessionId, action, targetUserId, actorId });
    } catch {
      /* audit row remains the source of truth; clients converge on refetch */
    }
  }

  async kickViewer(sessionId: string, actorId: string, targetUserId: string) {
    const session = await this.assertLiveHostOrModerator(sessionId, actorId);
    if (targetUserId === session.hostId) throw new BadRequestException('Cannot kick the host');
    await this.prisma.liveViewer.updateMany({ where: { sessionId, userId: targetUserId, leftAt: null }, data: { leftAt: new Date() } });
    await this.logLiveModeration(actorId, 'KICK', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'KICK', actorId, targetUserId);
    await this.publishViewerCount(sessionId);
    return { removed: true };
  }

  async muteViewer(sessionId: string, actorId: string, targetUserId: string) {
    const session = await this.assertLiveHostOrModerator(sessionId, actorId);
    if (targetUserId === session.hostId) throw new BadRequestException('Cannot mute the host');
    await this.logLiveModeration(actorId, 'MUTE', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'MUTE', actorId, targetUserId);
    return { muted: true };
  }

  async unmuteViewer(sessionId: string, actorId: string, targetUserId: string) {
    await this.assertLiveHostOrModerator(sessionId, actorId);
    await this.logLiveModeration(actorId, 'UNMUTE', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'UNMUTE', actorId, targetUserId);
    return { muted: false };
  }

  async banViewer(sessionId: string, actorId: string, targetUserId: string) {
    const session = await this.assertLiveHostOrModerator(sessionId, actorId);
    if (targetUserId === session.hostId) throw new BadRequestException('Cannot ban the host');
    await this.prisma.liveViewer.updateMany({ where: { sessionId, userId: targetUserId, leftAt: null }, data: { leftAt: new Date() } });
    await this.logLiveModeration(actorId, 'BAN', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'BAN', actorId, targetUserId);
    await this.publishViewerCount(sessionId);
    return { banned: true };
  }

  async unbanViewer(sessionId: string, actorId: string, targetUserId: string) {
    await this.assertLiveHostOrModerator(sessionId, actorId);
    await this.logLiveModeration(actorId, 'UNBAN', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'UNBAN', actorId, targetUserId);
    return { banned: false };
  }

  async addModerator(sessionId: string, actorId: string, targetUserId: string) {
    const session = await this.assertLiveHost(sessionId, actorId);
    if (targetUserId === session.hostId) throw new BadRequestException('The host is already an admin');
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');
    await this.prisma.liveModerator.upsert({
      where: { sessionId_userId: { sessionId, userId: targetUserId } },
      update: {},
      create: { sessionId, userId: targetUserId },
    });
    await this.logLiveModeration(actorId, 'ADD_MODERATOR', sessionId, targetUserId);
    return { added: true };
  }

  async removeModerator(sessionId: string, actorId: string, targetUserId: string) {
    await this.assertLiveHost(sessionId, actorId);
    await this.prisma.liveModerator.deleteMany({ where: { sessionId, userId: targetUserId } });
    await this.logLiveModeration(actorId, 'REMOVE_MODERATOR', sessionId, targetUserId);
    return { removed: true };
  }

  async listViewers(sessionId: string, hostId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: { hostId: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.hostId !== hostId) {
      const mod = await this.prisma.liveModerator.findUnique({ where: { sessionId_userId: { sessionId, userId: hostId } } });
      if (!mod) throw new ForbiddenException('Only the host or moderator can list viewers');
    }

    const viewers = await this.prisma.liveViewer.findMany({
      where: { sessionId, leftAt: null },
      orderBy: { joinedAt: 'asc' },
      select: {
        userId: true,
        joinedAt: true,
        user: { select: { id: true, displayName: true } },
      },
    });

    const mods = await this.prisma.liveModerator.findMany({ where: { sessionId }, select: { userId: true } });
    const modIds = new Set(mods.map((m) => m.userId));
    return viewers.map((v) => ({
      userId: v.userId,
      displayName: v.user.displayName,
      joinedAt: v.joinedAt,
      isModerator: modIds.has(v.userId),
    }));
  }
}