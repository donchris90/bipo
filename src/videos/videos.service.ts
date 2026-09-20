import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER, type StorageProvider } from './providers/storage-provider.interface';
import {
  DEFAULT_MAX_VIDEO_BYTES,
  cleanOptionalText,
  cleanTitle,
  keyBelongsTo,
  storageKeyFor,
} from './video-rules';

const VIEW_DEDUPE_MS = 30 * 60_000;

interface VideoRow {
  id: string;
  creatorId: string;
  title: string;
  caption: string | null;
  tag: string | null;
  videoUrl: string;
  durationSeconds: number | null;
  allowGifts: boolean;
  status: string;
  viewCount: number;
  likeCount: number;
  createdAt: Date;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);
  // userId:videoId -> last counted view. In-memory / single-instance, same
  // trade-off (and the same move-to-Redis note) as the live like throttle.
  private recentViews = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private get maxBytes(): number {
    const n = Number(this.config.get<string>('MAX_VIDEO_BYTES'));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_VIDEO_BYTES;
  }

  // ── Upload: two steps so the bytes go straight to storage ───────

  // Step 1: validate what the client intends to upload and hand back a
  // short-lived upload URL for a key under the caller's own prefix.
  async requestUpload(userId: string, contentType: string, sizeBytes: number) {
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new BadRequestException('sizeBytes must be a positive integer');
    if (sizeBytes > this.maxBytes) {
      throw new BadRequestException(`Video is too large (limit ${Math.floor(this.maxBytes / (1024 * 1024))} MB)`);
    }
    const storageKey = storageKeyFor(userId, uuid(), contentType); // also validates contentType
    const upload = await this.storage.createUpload({ key: storageKey, contentType });
    return { storageKey, ...upload };
  }

  // Step 2: the file is uploaded — verify it really is there and within the
  // limit (the client's declared size is not trusted), then publish.
  async publish(
    userId: string,
    countryCode: string,
    input: {
      storageKey: string;
      title: unknown;
      caption?: unknown;
      tag?: unknown;
      durationSeconds?: unknown;
      allowGifts?: unknown;
    },
  ) {
    if (!keyBelongsTo(userId, input.storageKey)) throw new BadRequestException('Invalid storageKey');
    const title = cleanTitle(input.title);
    const caption = cleanOptionalText(input.caption, 'Caption', 500);
    const tag = cleanOptionalText(input.tag, 'Tag', 40);

    const head = await this.storage.headObject(input.storageKey);
    if (!head) throw new BadRequestException('Upload not found — upload the file before publishing');
    if (head.sizeBytes > this.maxBytes) {
      await this.storage.deleteObject(input.storageKey).catch(() => {});
      throw new BadRequestException('Uploaded video exceeds the size limit');
    }

    const durationSeconds =
      typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0
        ? Math.round(input.durationSeconds) // client-reported, informational only
        : null;
    const ext = input.storageKey.split('.').pop() as string;
    const contentType = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';

    try {
      const video = await this.prisma.video.create({
        data: {
          creatorId: userId,
          title,
          caption: caption ?? null,
          tag: tag ?? null,
          storageKey: input.storageKey,
          videoUrl: this.storage.publicUrl(input.storageKey),
          contentType,
          sizeBytes: head.sizeBytes,
          durationSeconds,
          allowGifts: input.allowGifts === false ? false : true,
          countryCode,
        },
      });
      return this.toOwnerView(video);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This upload has already been published');
      }
      throw e;
    }
  }

  // ── Creator's own videos ────────────────────────────────────────

  async mine(userId: string) {
    const where = { creatorId: userId, status: 'PUBLISHED' as const };
    const [videos, totals, count] = await Promise.all([
      this.prisma.video.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.video.aggregate({ where, _sum: { viewCount: true, likeCount: true } }),
      this.prisma.video.count({ where }),
    ]);
    return {
      totals: { videos: count, views: totals._sum.viewCount ?? 0, likes: totals._sum.likeCount ?? 0 },
      videos: videos.map((v) => this.toOwnerView(v)),
    };
  }

  async update(
    userId: string,
    videoId: string,
    input: { title?: unknown; caption?: unknown; tag?: unknown; allowGifts?: unknown },
  ) {
    const video = await this.ownedVideo(userId, videoId);
    const data: Prisma.VideoUpdateInput = {};
    if (input.title !== undefined) data.title = cleanTitle(input.title);
    const caption = cleanOptionalText(input.caption, 'Caption', 500);
    if (caption !== undefined) data.caption = caption;
    const tag = cleanOptionalText(input.tag, 'Tag', 40);
    if (tag !== undefined) data.tag = tag;
    if (typeof input.allowGifts === 'boolean') data.allowGifts = input.allowGifts;

    const updated = await this.prisma.video.update({ where: { id: video.id }, data });
    return this.toOwnerView(updated);
  }

  // Soft delete: the row (and its like/view history) stays for moderation
  // and audit, but it disappears from every feed and endpoint. The stored
  // file is removed best-effort.
  async remove(userId: string, videoId: string) {
    const video = await this.ownedVideo(userId, videoId);
    await this.prisma.video.update({ where: { id: video.id }, data: { status: 'REMOVED' } });
    await this.storage.deleteObject(video.storageKey).catch((e) => {
      this.logger.warn(`Could not delete stored file for video ${video.id}: ${e?.message ?? e}`);
    });
    return { removed: true };
  }

  // ── Viewing ─────────────────────────────────────────────────────

  // Newest first. `before` (createdAt of the last item loaded) pages back.
  async feed(viewerId: string, limit?: number, before?: string) {
    const take = Math.min(Math.max(Math.floor(limit ?? 20) || 20, 1), 50);
    let beforeDate: Date | undefined;
    if (before) {
      beforeDate = new Date(before);
      if (Number.isNaN(beforeDate.getTime())) throw new BadRequestException('before must be an ISO timestamp');
    }

    const videos = await this.prisma.video.findMany({
      where: { status: 'PUBLISHED', ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return this.toViewerViews(viewerId, videos);
  }

  async get(viewerId: string, videoId: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video || video.status !== 'PUBLISHED') throw new NotFoundException('Video not found');
    return (await this.toViewerViews(viewerId, [video]))[0];
  }

  async recordView(viewerId: string, videoId: string) {
    const key = `${viewerId}:${videoId}`;
    const now = Date.now();
    const last = this.recentViews.get(key);
    if (last !== undefined && now - last < VIEW_DEDUPE_MS) return { counted: false };

    const video = await this.prisma.video.findUnique({ where: { id: videoId }, select: { creatorId: true, status: true } });
    if (!video || video.status !== 'PUBLISHED') throw new NotFoundException('Video not found');
    if (video.creatorId === viewerId) return { counted: false }; // your own plays don't count

    await this.prisma.video.update({ where: { id: videoId }, data: { viewCount: { increment: 1 } } });
    this.recentViews.set(key, now);
    if (this.recentViews.size > 10_000) {
      for (const [k, at] of this.recentViews) if (now - at > VIEW_DEDUPE_MS) this.recentViews.delete(k);
    }
    return { counted: true };
  }

  // Like/unlike are idempotent: the (video, user) unique row is the source
  // of truth and likeCount only moves when a row is actually added/removed.
  async like(userId: string, videoId: string) {
    await this.assertPublished(videoId);
    try {
      await this.prisma.$transaction([
        this.prisma.videoLike.create({ data: { videoId, userId } }),
        this.prisma.video.update({ where: { id: videoId }, data: { likeCount: { increment: 1 } } }),
      ]);
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      // already liked — nothing to change
    }
    return this.likeState(userId, videoId);
  }

  async unlike(userId: string, videoId: string) {
    await this.assertPublished(videoId);
    const removed = await this.prisma.videoLike.deleteMany({ where: { videoId, userId } });
    if (removed.count > 0) {
      await this.prisma.video.update({ where: { id: videoId }, data: { likeCount: { decrement: 1 } } });
    }
    return this.likeState(userId, videoId);
  }

  // ── helpers ─────────────────────────────────────────────────────

  private async ownedVideo(userId: string, videoId: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video || video.status !== 'PUBLISHED') throw new NotFoundException('Video not found');
    if (video.creatorId !== userId) throw new ForbiddenException('You can only change your own videos');
    return video;
  }

  private async assertPublished(videoId: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId }, select: { status: true } });
    if (!video || video.status !== 'PUBLISHED') throw new NotFoundException('Video not found');
  }

  private async likeState(userId: string, videoId: string) {
    const [video, mine] = await Promise.all([
      this.prisma.video.findUnique({ where: { id: videoId }, select: { likeCount: true } }),
      this.prisma.videoLike.findUnique({ where: { videoId_userId: { videoId, userId } }, select: { id: true } }),
    ]);
    return { liked: !!mine, likeCount: video?.likeCount ?? 0 };
  }

  private toOwnerView(v: VideoRow) {
    return {
      id: v.id,
      title: v.title,
      caption: v.caption,
      tag: v.tag,
      videoUrl: v.videoUrl,
      durationSeconds: v.durationSeconds,
      allowGifts: v.allowGifts,
      viewCount: v.viewCount,
      likeCount: v.likeCount,
      createdAt: v.createdAt,
    };
  }

  private async toViewerViews(viewerId: string, videos: VideoRow[]) {
    if (videos.length === 0) return [];
    const [creators, liked] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(videos.map((v) => v.creatorId))] } },
        select: { id: true, displayName: true },
      }),
      this.prisma.videoLike.findMany({
        where: { userId: viewerId, videoId: { in: videos.map((v) => v.id) } },
        select: { videoId: true },
      }),
    ]);
    const nameById = new Map(creators.map((c) => [c.id, c.displayName]));
    const likedIds = new Set(liked.map((l) => l.videoId));

    return videos.map((v) => ({
      ...this.toOwnerView(v),
      creator: { id: v.creatorId, displayName: nameById.get(v.creatorId) ?? null },
      likedByMe: likedIds.has(v.id),
    }));
  }
}
