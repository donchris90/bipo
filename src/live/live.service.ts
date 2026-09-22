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

export const RTC_PROVIDER = 'RTC_PROVIDER';

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    private readonly featureFlags: FeatureFlagsService,
    private readonly realtime: RealtimeGateway,
    @Optional() private readonly media?: LiveMediaService,
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
        coverUrl: LiveService.cleanCoverUrl(coverUrl),
        dailyTargetCoins: Number.isFinite(dailyTargetCoins)
          ? Math.max(100, Math.min(10_000_000, Math.floor(dailyTargetCoins!)))
          : null,
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

    const token = await this.rtc.generateToken(session.providerChannel, userId, 'audience');

    // Record the viewer so the host's gift picker can see them. Added
    // after token generation so a token failure doesn't leave a stale
    // viewer row.
    await this.trackViewerJoin(sessionId, userId);

    return { session, token };
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
      where: { status: 'LIVE' },
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