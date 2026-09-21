import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { STORAGE_PROVIDER, type StorageProvider } from './providers/storage-provider.interface';
import { DEFAULT_MAX_VIDEO_BYTES, cleanOptionalText, cleanTitle, keyBelongsTo } from './video-rules';
import { MAX_MUSIC_BYTES, MAX_OVERLAY_BYTES, MAX_SOURCE_SECONDS, cleanEditSpec, editKeyBelongsTo, editKeyFor, type EditAsset } from './edit-spec';
import { buildRenderArgs, probeFile, run, thumbnailArgs } from './ffmpeg';

const MAX_ACTIVE_PER_USER = 2;
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
const FRIENDLY_FAILURE = 'We could not process this video. Try a different file, or fewer edits.';

// Videos edited on the server. The app uploads the original (and, if used, the
// text/sticker picture and a song), then asks for a render; jobs are done one at a
// time in the background, and when one finishes the finished video is published and
// the creator is told. Jobs are kept in the database, so a restart picks up where
// it left off.
@Injectable()
export class VideoEditService implements OnModuleInit {
  private readonly logger = new Logger(VideoEditService.name);
  private readonly queue: string[] = [];
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async onModuleInit() {
    if (process.env.JEST_WORKER_ID) return;
    try {
      // Anything that was mid-render when the server stopped starts again.
      await this.prisma.videoEditJob.updateMany({ where: { status: 'PROCESSING' }, data: { status: 'QUEUED' } });
      const pending = await this.prisma.videoEditJob.findMany({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
      pending.forEach((j) => this.enqueue(j.id));
    } catch (e: any) {
      this.logger.warn(`Could not resume edit jobs: ${e?.message ?? e}`);
    }
  }

  private get maxBytes(): number {
    const n = Number(this.config.get<string>('MAX_VIDEO_BYTES'));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_VIDEO_BYTES;
  }

  // The text/sticker picture and a song are uploaded the same way as a video: a
  // short-lived upload address for a file under the caller's own folder.
  async requestAssetUpload(userId: string, asset: unknown, contentType: string, sizeBytes: number) {
    if (asset !== 'overlay' && asset !== 'music') throw new BadRequestException("asset must be 'overlay' or 'music'");
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new BadRequestException('sizeBytes must be a positive integer');
    const limit = asset === 'overlay' ? MAX_OVERLAY_BYTES : MAX_MUSIC_BYTES;
    if (sizeBytes > limit) throw new BadRequestException(`That file is too large (limit ${Math.floor(limit / (1024 * 1024))} MB)`);
    const storageKey = editKeyFor(userId, uuid(), asset as EditAsset, contentType);
    const upload = await this.storage.createUpload({ key: storageKey, contentType });
    return { storageKey, ...upload };
  }

  async create(
    userId: string,
    countryCode: string,
    body: { sourceKey?: unknown; overlayKey?: unknown; musicKey?: unknown; musicTitle?: unknown; spec?: unknown; title?: unknown; caption?: unknown; tag?: unknown; allowGifts?: unknown },
  ) {
    if (!keyBelongsTo(userId, body.sourceKey as string)) throw new BadRequestException('Invalid sourceKey');
    const overlayKey = body.overlayKey == null ? null : body.overlayKey;
    const musicKey = body.musicKey == null ? null : body.musicKey;
    if (overlayKey !== null && !editKeyBelongsTo(userId, overlayKey, 'overlay')) throw new BadRequestException('Invalid overlayKey');
    if (musicKey !== null && !editKeyBelongsTo(userId, musicKey, 'music')) throw new BadRequestException('Invalid musicKey');

    const spec = cleanEditSpec(body.spec);
    const title = cleanTitle(body.title);
    const caption = cleanOptionalText(body.caption, 'Caption', 500);
    const tag = cleanOptionalText(body.tag, 'Tag', 40);
    const musicTitle = cleanOptionalText(body.musicTitle, 'Music title', 60);
    if (body.allowGifts !== undefined && typeof body.allowGifts !== 'boolean') throw new BadRequestException('allowGifts must be true or false');

    const active = await this.prisma.videoEditJob.count({ where: { userId, status: { in: ['QUEUED', 'PROCESSING'] } } });
    if (active >= MAX_ACTIVE_PER_USER) throw new HttpException(`You already have ${MAX_ACTIVE_PER_USER} videos being processed. Wait for one to finish.`, HttpStatus.TOO_MANY_REQUESTS);

    // The uploads must really be there, and the video within the size limit.
    const head = await this.storage.headObject(body.sourceKey as string);
    if (!head) throw new BadRequestException('Upload not found — upload the video before editing it');
    if (head.sizeBytes > this.maxBytes) {
      await this.storage.deleteObject(body.sourceKey as string).catch(() => {});
      throw new BadRequestException('Uploaded video exceeds the size limit');
    }
    if (overlayKey && !(await this.storage.headObject(overlayKey as string))) throw new BadRequestException('The text and sticker layer was not uploaded');
    if (musicKey && !(await this.storage.headObject(musicKey as string))) throw new BadRequestException('The music was not uploaded');

    const job = await this.prisma.videoEditJob.create({
      data: {
        userId,
        countryCode,
        sourceKey: body.sourceKey as string,
        overlayKey: overlayKey as string | null,
        musicKey: musicKey as string | null,
        spec: spec as any,
        title,
        caption: caption ?? null,
        tag: tag ?? null,
        allowGifts: body.allowGifts ?? true,
        musicTitle: musicTitle ?? null,
      },
    });
    this.enqueue(job.id);
    return this.view(job);
  }

  async get(userId: string, jobId: string) {
    const job = await this.prisma.videoEditJob.findUnique({ where: { id: jobId } });
    if (!job || job.userId !== userId) throw new NotFoundException('Job not found');
    return this.view(job);
  }

  private view(job: { id: string; status: string; videoId: string | null; error: string | null; createdAt: Date }) {
    return { id: job.id, status: job.status, videoId: job.videoId, error: job.error, createdAt: job.createdAt };
  }

  // ── the queue: one render at a time (rendering is heavy) ─────────────────

  enqueue(jobId: string) {
    this.queue.push(jobId);
    void this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift() as string;
        await this.process(id).catch((e) => this.logger.error(`Edit job ${id} crashed: ${e?.message ?? e}`));
      }
    } finally {
      this.running = false;
    }
  }

  async process(jobId: string) {
    const job = await this.prisma.videoEditJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'QUEUED') return;
    await this.prisma.videoEditJob.update({ where: { id: jobId }, data: { status: 'PROCESSING', startedAt: new Date() } });

    const dir = await mkdtemp(join(tmpdir(), 'rryda-edit-'));
    const uploaded: string[] = [];
    try {
      const src = join(dir, 'source');
      const overlay = job.overlayKey ? join(dir, 'overlay.png') : null;
      const music = job.musicKey ? join(dir, 'music') : null;
      await this.download(job.sourceKey, src);
      if (overlay) await this.download(job.overlayKey as string, overlay);
      if (music) await this.download(job.musicKey as string, music);

      const probe = await probeFile(src);
      if (probe.durationMs > MAX_SOURCE_SECONDS * 1000) throw new Error('The video is too long to edit (10 minutes at most)');

      const out = join(dir, 'out.mp4');
      const plan = buildRenderArgs({ srcPath: src, overlayPath: overlay, musicPath: music, outPath: out, probe, spec: cleanEditSpec(job.spec) });
      const result = await run(plan.args, RENDER_TIMEOUT_MS);
      if (result.code !== 0) throw new Error(`ffmpeg exited ${result.code}: ${result.stderr.slice(-800)}`);
      const outProbe = await probeFile(out);

      const thumb = join(dir, 'thumb.jpg');
      const thumbOk = (await run(thumbnailArgs(out, thumb, Math.min(0.5, outProbe.durationMs / 2000)), 30_000).catch(() => ({ code: 1 }))).code === 0;

      const videoKey = `videos/${job.userId}/${uuid()}.mp4`;
      await this.put(videoKey, out, 'video/mp4', uploaded);
      let thumbnailUrl: string | null = null;
      if (thumbOk) {
        const thumbKey = `thumbnails/${job.userId}/${uuid()}.jpg`;
        await this.put(thumbKey, thumb, 'image/jpeg', uploaded);
        thumbnailUrl = this.storage.publicUrl(thumbKey);
      }
      const { size } = await stat(out);

      const video = await this.prisma.video.create({
        data: {
          creatorId: job.userId,
          title: job.title,
          caption: job.caption,
          tag: job.tag,
          storageKey: videoKey,
          videoUrl: this.storage.publicUrl(videoKey),
          contentType: 'video/mp4',
          sizeBytes: size,
          durationSeconds: Math.round(outProbe.durationMs / 1000),
          allowGifts: job.allowGifts,
          countryCode: job.countryCode,
          musicTitle: job.musicTitle,
          thumbnailUrl,
        },
      });
      await this.prisma.videoEditJob.update({ where: { id: jobId }, data: { status: 'DONE', videoId: video.id, finishedAt: new Date() } });
      // The originals are no longer needed.
      for (const key of [job.sourceKey, job.overlayKey, job.musicKey]) if (key) await this.storage.deleteObject(key).catch(() => {});
      await this.notifications.notify(job.userId, 'SYSTEM', { event: 'video_ready', videoId: video.id, title: job.title });
    } catch (e: any) {
      this.logger.error(`Edit job ${jobId} failed: ${e?.message ?? e}`);
      for (const key of uploaded) await this.storage.deleteObject(key).catch(() => {});
      const known = typeof e?.message === 'string' && /too long to edit|could not be read as a video|took too long/.test(e.message);
      const message = known ? e.message.split('\n')[0].slice(0, 200) : FRIENDLY_FAILURE;
      await this.prisma.videoEditJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: message, finishedAt: new Date() } }).catch(() => {});
      for (const key of [job.sourceKey, job.overlayKey, job.musicKey]) if (key) await this.storage.deleteObject(key).catch(() => {});
      await this.notifications.notify(job.userId, 'SYSTEM', { event: 'video_failed', title: job.title, reason: message });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async download(key: string, path: string) {
    if (!this.storage.readObject) throw new Error('Video storage cannot be read');
    const obj = await this.storage.readObject(key);
    if (!obj) throw new Error('An uploaded file is missing');
    await pipeline(obj.body as NodeJS.ReadableStream, createWriteStream(path));
  }

  private async put(key: string, path: string, contentType: string, uploaded: string[]) {
    if (!this.storage.putFile) throw new Error('Video storage cannot be written');
    await this.storage.putFile(key, path, contentType);
    uploaded.push(key);
  }
}
