import { execFileSync } from 'child_process';
import { copyFileSync, createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BadRequestException, HttpException } from '@nestjs/common';
import { VideoEditService } from './video-edit.service';
import { ffmpegPath, probeFile } from './ffmpeg';

let bin = '';
try {
  bin = ffmpegPath();
} catch {
  /* skipped below */
}

// An in-memory stand-in for the bucket, backed by real files so ffmpeg can read them.
function makeStorage(dir: string) {
  const files = new Map<string, string>(); // key -> local path
  return {
    files,
    headObject: jest.fn(async (key: string) => (files.has(key) ? { sizeBytes: statSync(files.get(key)!).size } : null)),
    createUpload: jest.fn(async ({ key }: any) => ({ uploadUrl: `https://up/${key}`, method: 'PUT', headers: {}, expiresInSeconds: 900 })),
    readObject: jest.fn(async (key: string) => (files.has(key) ? { body: createReadStream(files.get(key)!), contentType: 'x', contentLength: 1, contentRange: null, partial: false } : null)),
    putFile: jest.fn(async (key: string, path: string) => {
      const dest = join(dir, `stored-${files.size}-${key.replace(/\W/g, '_')}`);
      copyFileSync(path, dest);
      files.set(key, dest);
    }),
    deleteObject: jest.fn(async (key: string) => void files.delete(key)),
    publicUrl: (key: string) => `https://cdn/${key}`,
  };
}

function makePrisma() {
  const jobs = new Map<string, any>();
  const videos: any[] = [];
  let n = 0;
  return {
    jobs,
    videos,
    videoEditJob: {
      count: jest.fn(async ({ where }: any) => [...jobs.values()].filter((j) => j.userId === where.userId && where.status.in.includes(j.status)).length),
      create: jest.fn(async ({ data }: any) => {
        const job = { id: `job${++n}`, status: 'QUEUED', videoId: null, error: null, createdAt: new Date(), ...data };
        jobs.set(job.id, job);
        return job;
      }),
      findUnique: jest.fn(async ({ where }: any) => jobs.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(jobs.get(where.id), data)),
      updateMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    video: { create: jest.fn(async ({ data }: any) => { const v = { id: `vid${videos.length + 1}`, ...data }; videos.push(v); return v; }) },
  };
}

const real = bin ? describe : describe.skip;

real('VideoEditService (with the real ffmpeg)', () => {
  jest.setTimeout(120_000);
  let dir = '';
  let srcFile = '';
  let overlayFile = '';
  let musicFile = '';
  const gen = (args: string[]) => execFileSync(bin, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'editsvc-'));
    srcFile = join(dir, 'src.mp4');
    overlayFile = join(dir, 'ov.png');
    musicFile = join(dir, 'm.m4a');
    gen(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x568:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', srcFile]);
    gen(['-f', 'lavfi', '-i', 'color=c=blue@0.6:s=100x100,format=rgba', '-frames:v', '1', overlayFile]);
    gen(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:a', 'aac', musicFile]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const build = () => {
    const storage = makeStorage(dir);
    const prisma = makePrisma();
    const notifications: any = { notify: jest.fn() };
    const svc = new VideoEditService(prisma as any, { get: () => undefined } as any, notifications, storage as any);
    // The tests run the job themselves (in the real service enqueue() starts it in the background).
    jest.spyOn(svc, 'enqueue').mockImplementation(() => undefined);
    const upload = (key: string, file: string) => storage.files.set(key, file);
    return { svc, storage, prisma, notifications, upload };
  };
  const body = (over: any = {}) => ({ sourceKey: 'videos/u1/a.mp4', title: 'My edit', spec: {}, ...over });

  it('renders an edited video end to end: downloads, renders, publishes with a thumbnail, cleans up, tells the creator', async () => {
    const { svc, storage, prisma, notifications, upload } = build();
    upload('videos/u1/a.mp4', srcFile);
    upload('edits/u1/o.png', overlayFile);
    upload('edits/u1/m.m4a', musicFile);

    const created = await svc.create('u1', 'NG', body({ overlayKey: 'edits/u1/o.png', musicKey: 'edits/u1/m.m4a', musicTitle: 'Song - Artist', caption: 'hi', spec: { trim: { startMs: 500, endMs: 3500 }, speed: 1.5, filter: 'warm', effect: 'vignette' } }));
    expect(created.status).toBe('QUEUED');
    await svc.process(created.id);

    const job = prisma.jobs.get(created.id);
    expect(job).toMatchObject({ status: 'DONE', videoId: 'vid1' });
    const video = prisma.videos[0];
    expect(video).toMatchObject({ creatorId: 'u1', title: 'My edit', caption: 'hi', musicTitle: 'Song - Artist', contentType: 'video/mp4', countryCode: 'NG' });
    expect(video.storageKey).toMatch(/^videos\/u1\/.+\.mp4$/);
    expect(video.videoUrl).toBe(`https://cdn/${video.storageKey}`);
    expect(video.thumbnailUrl).toMatch(/^https:\/\/cdn\/thumbnails\/u1\/.+\.jpg$/);
    // the finished file is a real video: 3 s of source at 1.5x = about 2 s, with sound
    const stored = await probeFile(storage.files.get(video.storageKey)!);
    expect(stored.durationMs).toBeGreaterThan(1700);
    expect(stored.durationMs).toBeLessThan(2400);
    expect(stored.hasAudio).toBe(true);
    // originals removed; the creator told
    expect(storage.files.has('videos/u1/a.mp4')).toBe(false);
    expect(storage.files.has('edits/u1/o.png')).toBe(false);
    expect(notifications.notify).toHaveBeenCalledWith('u1', 'SYSTEM', { event: 'video_ready', videoId: 'vid1', title: 'My edit' });
  });

  it('a file that is not a video fails cleanly: a friendly message, nothing left behind, the creator told', async () => {
    const { svc, storage, prisma, notifications, upload } = build();
    const junk = join(dir, 'junk.mp4');
    writeFileSync(junk, 'not a video at all');
    upload('videos/u1/bad.mp4', junk);
    const created = await svc.create('u1', 'NG', body({ sourceKey: 'videos/u1/bad.mp4' }));
    await svc.process(created.id);
    const job = prisma.jobs.get(created.id);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/could not be read as a video/);
    expect(prisma.videos).toHaveLength(0);
    expect(storage.files.size).toBe(0);
    expect(notifications.notify).toHaveBeenCalledWith('u1', 'SYSTEM', expect.objectContaining({ event: 'video_failed' }));
  });

  it("an unexpected failure shows a friendly message, never ffmpeg's technical output", async () => {
    const { svc, prisma, upload } = build();
    upload('videos/u1/a.mp4', srcFile);
    const created = await svc.create('u1', 'NG', body());
    (svc as any).storage.readObject = jest.fn().mockRejectedValue(new Error('ECONNRESET at /opt/render/project/src'));
    await svc.process(created.id);
    expect(prisma.jobs.get(created.id).error).toBe('We could not process this video. Try a different file, or fewer edits.');
  });

  it('only processes a job that is waiting, once', async () => {
    const { svc, prisma, upload } = build();
    upload('videos/u1/a.mp4', srcFile);
    const created = await svc.create('u1', 'NG', body());
    await svc.process(created.id);
    await svc.process(created.id); // already DONE: nothing happens
    expect(prisma.videos).toHaveLength(1);
  });
});

describe('VideoEditService.create — the checks before any work is done', () => {
  const build = (over: { existing?: string[]; active?: number } = {}) => {
    const storage = makeStorage(tmpdir());
    (storage.headObject as jest.Mock).mockImplementation(async (k: string) => (over.existing ?? ['videos/u1/a.mp4']).includes(k) ? { sizeBytes: 1000 } : null);
    const prisma: any = makePrisma();
    prisma.videoEditJob.count.mockResolvedValue(over.active ?? 0);
    const svc = new VideoEditService(prisma, { get: () => undefined } as any, { notify: jest.fn() } as any, storage as any);
    jest.spyOn(svc, 'enqueue').mockImplementation(() => undefined);
    return { svc, prisma, storage };
  };
  const good = { sourceKey: 'videos/u1/a.mp4', title: 'T', spec: { filter: 'mono' } };

  it('accepts a valid request and queues it', async () => {
    const { svc, prisma } = build();
    const job = await svc.create('u1', 'NG', good);
    expect(job.status).toBe('QUEUED');
    expect(prisma.videoEditJob.create.mock.calls[0][0].data).toMatchObject({ userId: 'u1', title: 'T', allowGifts: true });
  });

  it("refuses someone else's files, bad choices, and a video that was never uploaded", async () => {
    const { svc } = build();
    await expect(svc.create('u1', 'NG', { ...good, sourceKey: 'videos/u2/a.mp4' })).rejects.toThrow(/Invalid sourceKey/);
    await expect(svc.create('u1', 'NG', { ...good, overlayKey: 'edits/u2/o.png' })).rejects.toThrow(/Invalid overlayKey/);
    await expect(svc.create('u1', 'NG', { ...good, musicKey: 'edits/u1/o.png' })).rejects.toThrow(/Invalid musicKey/);
    await expect(svc.create('u1', 'NG', { ...good, spec: { filter: 'evil' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create('u1', 'NG', { ...good, title: '  ' })).rejects.toThrow(/Title is required/);
    await expect(build({ existing: [] }).svc.create('u1', 'NG', good)).rejects.toThrow(/Upload not found/);
    await expect(build().svc.create('u1', 'NG', { ...good, overlayKey: 'edits/u1/o.png' })).rejects.toThrow(/not uploaded/);
  });

  it('at most 2 videos being processed at once per person', async () => {
    const { svc } = build({ active: 2 });
    await expect(svc.create('u1', 'NG', good)).rejects.toBeInstanceOf(HttpException);
    await expect(svc.create('u1', 'NG', good)).rejects.toThrow(/already have 2 videos/);
  });

  it('upload addresses: only the two kinds of file, within their size limits', async () => {
    const { svc } = build();
    expect((await svc.requestAssetUpload('u1', 'overlay', 'image/png', 1000)).storageKey).toMatch(/^edits\/u1\/.+\.png$/);
    expect((await svc.requestAssetUpload('u1', 'music', 'audio/mpeg', 1000)).storageKey).toMatch(/\.mp3$/);
    await expect(svc.requestAssetUpload('u1', 'movie', 'image/png', 1000)).rejects.toThrow(/asset must be/);
    await expect(svc.requestAssetUpload('u1', 'overlay', 'image/png', 6 * 1024 * 1024)).rejects.toThrow(/too large/);
    await expect(svc.requestAssetUpload('u1', 'music', 'audio/mpeg', 31 * 1024 * 1024)).rejects.toThrow(/too large/);
  });

  it('a job can only be read by the person who made it', async () => {
    const { svc, prisma } = build();
    const job = await svc.create('u1', 'NG', good);
    expect((await svc.get('u1', job.id)).id).toBe(job.id);
    await expect(svc.get('someone-else', job.id)).rejects.toThrow(/Job not found/);
  });
});
