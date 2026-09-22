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
import { LedgerEntryType, WalletType } from '@prisma/client';

export const RTC_PROVIDER = 'RTC_PROVIDER';

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    private readonly featureFlags: FeatureFlagsService,
    private readonly realtime: RealtimeGateway,
    private readonly moderation: ModerationService,
    @Optional() private readonly media?: LiveMediaService,
    private readonly wallet: WalletService,
    private readonly revenueSplit: RevenueSplitService,
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
    privatePriceCoins?: number,
    privateDurationMinutes?: number,
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
    let normalizedPrivatePrice: number | null = null;
    let normalizedPrivateDuration: number | null = null;
    if (normalizedPrivacy === 'PRIVATE') {
      normalizedPrivatePrice = Math.round(Number(privatePriceCoins));
      normalizedPrivateDuration = Math.round(Number(privateDurationMinutes)) * 60;
      if (!Number.isInteger(normalizedPrivatePrice) || normalizedPrivatePrice < 1 || normalizedPrivatePrice > 10_000_000) {
        throw new BadRequestException('Private live price must be between 1 and 10,000,000 coins');
      }
      if (!Number.isInteger(normalizedPrivateDuration) || normalizedPrivateDuration < 60 || normalizedPrivateDuration > 2 * 60 * 60) {
        throw new BadRequestException('Private live duration must be between 1 and 120 minutes');
      }
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
        privatePriceCoins: normalizedPrivatePrice,
        privateDurationSeconds: normalizedPrivateDuration,
        providerChannel: channelName,
        status: 'LIVE',
        startedAt: new Date(),
      },
    });

    const token = await this.rtc.generateToken(channelName, hostId, 'host');
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
        await this.completePrivateRequest(request.id);
        await this.finish(session);
        throw new ForbiddenException('The paid private session has ended');
      }

      rtcRole = 'publisher'; // private 1-on-1 viewer must be able to publish video/audio
      if (request.status === 'ACCEPTED') {
        await this.startAndSettlePrivateRequest(request.id, session);
      }
    }

    const token = await this.rtc.generateToken(session.providerChannel, userId, rtcRole);
    if (session.hostId !== userId) {
      await this.trackViewerJoin(sessionId, userId);
    }

    return { session, token, private: session.privacy === 'PRIVATE' };
  }


  async requestPrivateAccess(sessionId: string, viewerId: string) {
    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'LIVE') throw new NotFoundException('Live session not found or not active');
    if (session.privacy !== 'PRIVATE') throw new BadRequestException('This live is not private');
    if (session.hostId === viewerId) throw new BadRequestException('The host cannot request their own private live');
    if (!session.privatePriceCoins || !session.privateDurationSeconds) {
      throw new BadRequestException('Private live pricing is not configured');
    }

    const existing = await this.prisma.privateLiveRequest.findFirst({
      where: { sessionId, viewerId, status: { in: ['PENDING', 'ACCEPTED', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    const requestId = uuid();
    await this.prisma.$transaction(async (tx) => {
      await this.wallet.debit({
        userId: viewerId,
        walletType: WalletType.COIN,
        amount: BigInt(session.privatePriceCoins!),
        ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT,
        reference: requestId,
        idempotencyKey: `private_live_debit:${requestId}`,
      }, tx);

      await tx.privateLiveRequest.create({
        data: {
          id: requestId,
          sessionId,
          viewerId,
          priceCoins: session.privatePriceCoins!,
          durationSeconds: session.privateDurationSeconds!,
          status: 'PENDING',
        },
      });
    });

    return this.getPrivateRequest(requestId, viewerId);
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

    return this.refundPrivateRequest(request.id, request.viewerId, request.priceCoins, 'Host declined private live request');
  }

  private async startAndSettlePrivateRequest(requestId: string, session: any) {
    const request = await this.prisma.privateLiveRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Private live request not found');
    if (request.status === 'ACTIVE') return request;
    if (request.status !== 'ACCEPTED') throw new ForbiddenException('Private access has not been accepted');

    const split = await this.revenueSplit.resolve(session.countryCode);
    const creatorShare = Math.floor((request.priceCoins * split.creatorShareBps) / 10000);
    const platformShare = request.priceCoins - creatorShare;
    const now = new Date();
    const endsAt = new Date(now.getTime() + request.durationSeconds * 1000);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.privateLiveRequest.updateMany({
        where: { id: requestId, status: 'ACCEPTED' },
        data: { status: 'ACTIVE', startedAt: now, endsAt, settledAt: now },
      });
      if (updated.count === 0) {
        return tx.privateLiveRequest.findUniqueOrThrow({ where: { id: requestId } });
      }

      if (creatorShare > 0) {
        await this.wallet.credit({
          userId: session.hostId,
          walletType: WalletType.CREATOR_EARNINGS,
          amount: BigInt(creatorShare),
          ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT,
          reference: requestId,
          idempotencyKey: `private_live_creator:${requestId}`,
        }, tx);
      }
      if (platformShare > 0) {
        await this.wallet.recordPlatformEntry({
          ledgerType: LedgerEntryType.PRIVATE_LIVE_PAYMENT,
          amount: BigInt(platformShare),
          reference: requestId,
          idempotencyKey: `private_live_platform:${requestId}`,
        }, tx);
      }

      await tx.liveSession.update({
        where: { id: session.id },
        data: { privateStartedAt: now, privateEndsAt: endsAt },
      });

      return tx.privateLiveRequest.findUniqueOrThrow({ where: { id: requestId } });
    });
  }

  private async refundPrivateRequest(requestId: string, viewerId: string, priceCoins: number, reason: string) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.privateLiveRequest.findUnique({ where: { id: requestId } });
      if (!current || ['REFUNDED', 'COMPLETED'].includes(current.status)) return current;
      await this.wallet.credit({
        userId: viewerId,
        walletType: WalletType.COIN,
        amount: BigInt(priceCoins),
        ledgerType: LedgerEntryType.REFUND,
        reference: requestId,
        idempotencyKey: `private_live_refund:${requestId}`,
      }, tx);
      return tx.privateLiveRequest.update({
        where: { id: requestId },
        data: { status: 'REFUNDED', refundedAt: now },
      });
    });
  }

  private async completePrivateRequest(requestId: string) {
    return this.prisma.privateLiveRequest.updateMany({
      where: { id: requestId, status: { in: ['ACCEPTED', 'ACTIVE'] } },
      data: { status: 'COMPLETED' },
    });
  }

  async sweepPrivateSessions() {
    const now = new Date();
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
    const request = await this.prisma.privateLiveRequest.findFirst({
      where: {
        sessionId,
        OR: [{ viewerId: actorId }, { session: { hostId: actorId } }],
        status: { in: ['PENDING', 'ACCEPTED', 'ACTIVE'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { viewer: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    return {
      session: {
        id: session.id,
        privacy: session.privacy,
        privatePriceCoins: session.privatePriceCoins,
        privateDurationSeconds: session.privateDurationSeconds,
        privateStartedAt: session.privateStartedAt,
        privateEndsAt: session.privateEndsAt,
      },
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
  private async finish(session: {
    id: string;
    providerChannel: string;
    status: string;
    startedAt: Date | null;
  }) {
    if (session.status === 'ENDED') {
      return this.prisma.liveSession.findUniqueOrThrow({ where: { id: session.id } });
    }
    // A video being shared in this live ends with it.
    this.media?.clear(session.id);

    await this.rtc.destroyChannel(session.providerChannel);

    // Paid requests that never became an active private session must be refunded
    // when the host ends the live. Active requests have already settled to the host.
    const unpaid = await this.prisma.privateLiveRequest.findMany({
      where: { sessionId: session.id, status: { in: ['PENDING', 'ACCEPTED'] } },
      select: { id: true, viewerId: true, priceCoins: true },
    });
    for (const request of unpaid) {
      await this.refundPrivateRequest(request.id, request.viewerId, request.priceCoins, 'Private live ended before access started');
    }
    await this.prisma.privateLiveRequest.updateMany({
      where: { sessionId: session.id, status: 'ACTIVE' },
      data: { status: 'COMPLETED' },
    });

    // Close all open viewer rows — the session is over.
    await this.prisma.liveViewer.updateMany({
      where: { sessionId: session.id, leftAt: null },
      data: { leftAt: new Date() },
    });

    const endedAt = new Date();
    const durationSeconds = session.startedAt
      ? Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000))
      : 0;

    return this.prisma.liveSession.update({
      where: { id: session.id },
      data: { status: 'ENDED', endedAt, durationSeconds },
    });
  }

  listLive() {
    return this.prisma.liveSession.findMany({
      where: { status: 'LIVE', privacy: 'PUBLIC' },
      orderBy: { startedAt: 'desc' },
      take: 50,
      select: {
        id: true, hostId: true, title: true, category: true, coverUrl: true,
        themeColor: true, status: true, startedAt: true, endedAt: true, durationSeconds: true,
      },
    });
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

  private async logLiveModeration(
    actorId: string,
    actionType: 'KICK' | 'MUTE' | 'UNMUTE' | 'BAN' | 'UNBAN',
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
    const session = await this.assertLiveHost(sessionId, actorId);
    if (targetUserId === session.hostId) throw new BadRequestException('Cannot kick the host');
    await this.prisma.liveViewer.updateMany({ where: { sessionId, userId: targetUserId, leftAt: null }, data: { leftAt: new Date() } });
    await this.logLiveModeration(actorId, 'KICK', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'KICK', actorId, targetUserId);
    await this.publishViewerCount(sessionId);
    return { removed: true };
  }

  async muteViewer(sessionId: string, actorId: string, targetUserId: string) {
    const session = await this.assertLiveHost(sessionId, actorId);
    if (targetUserId === session.hostId) throw new BadRequestException('Cannot mute the host');
    await this.logLiveModeration(actorId, 'MUTE', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'MUTE', actorId, targetUserId);
    return { muted: true };
  }

  async unmuteViewer(sessionId: string, actorId: string, targetUserId: string) {
    await this.assertLiveHost(sessionId, actorId);
    await this.logLiveModeration(actorId, 'UNMUTE', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'UNMUTE', actorId, targetUserId);
    return { muted: false };
  }

  async banViewer(sessionId: string, actorId: string, targetUserId: string) {
    const session = await this.assertLiveHost(sessionId, actorId);
    if (targetUserId === session.hostId) throw new BadRequestException('Cannot ban the host');
    await this.prisma.liveViewer.updateMany({ where: { sessionId, userId: targetUserId, leftAt: null }, data: { leftAt: new Date() } });
    await this.logLiveModeration(actorId, 'BAN', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'BAN', actorId, targetUserId);
    await this.publishViewerCount(sessionId);
    return { banned: true };
  }

  async unbanViewer(sessionId: string, actorId: string, targetUserId: string) {
    await this.assertLiveHost(sessionId, actorId);
    await this.logLiveModeration(actorId, 'UNBAN', sessionId, targetUserId);
    this.emitLiveModeration(sessionId, 'UNBAN', actorId, targetUserId);
    return { banned: false };
  }

  async listViewers(sessionId: string, hostId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: { hostId: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.hostId !== hostId) {
      throw new ForbiddenException('Only the host can list viewers');
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

    return viewers.map((v) => ({
      userId: v.userId,
      displayName: v.user.displayName,
      joinedAt: v.joinedAt,
    }));
  }
}