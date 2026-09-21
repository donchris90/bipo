import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { VideosService, hotScore } from './videos.service';

const NOW = Date.UTC(2026, 8, 21, 12);
const vid = (id: string, over: any = {}) => ({ id, creatorId: `c-${id}`, title: `Video ${id}`, caption: null, tag: null, videoUrl: `https://cdn/${id}.mp4`, durationSeconds: 10, allowGifts: true, status: 'PUBLISHED', viewCount: 0, likeCount: 0, shareCount: 0, musicTitle: null, createdAt: new Date(NOW - 3600_000), ...over });

function build(w: { videos?: any[]; follows?: string[]; blocks?: [string, string][]; comments?: any[]; gifts?: any[]; users?: any[] } = {}) {
  const videos = w.videos ?? [];
  const prisma: any = {
    block: { findMany: jest.fn(async () => (w.blocks ?? []).map(([a, b]) => ({ blockerId: a, blockedId: b }))), findFirst: jest.fn().mockResolvedValue(null) },
    follow: { findMany: jest.fn(async ({ where }: any) => (where.followingId?.in ? (w.follows ?? []).filter((f) => where.followingId.in.includes(f)).map((followingId) => ({ followingId })) : (w.follows ?? []).map((followingId) => ({ followingId })))) },
    video: {
      findMany: jest.fn(async (args: any) => {
        let rows = videos.filter((v) => v.status === 'PUBLISHED');
        const w2 = args.where ?? {};
        if (w2.creatorId?.in) rows = rows.filter((v) => w2.creatorId.in.includes(v.creatorId));
        if (w2.creatorId?.notIn) rows = rows.filter((v) => !w2.creatorId.notIn.includes(v.creatorId));
        if (w2.createdAt?.lt) rows = rows.filter((v) => v.createdAt < w2.createdAt.lt);
        if (w2.createdAt?.gte) rows = rows.filter((v) => v.createdAt >= w2.createdAt.gte);
        if (Array.isArray(args.orderBy) && args.orderBy[0]?.likeCount) rows = [...rows].sort((a, b) => b.likeCount - a.likeCount || b.viewCount - a.viewCount);
        else rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 100));
      }),
      findUnique: jest.fn(async ({ where }: any) => videos.find((v) => v.id === where.id) ?? null),
      update: jest.fn(async () => ({ shareCount: 4 })),
    },
    user: { findMany: jest.fn(async () => w.users ?? [{ id: 'c-a', displayName: 'Ada', avatarUrl: 'https://x/a.jpg' }]) },
    videoLike: { findMany: jest.fn().mockResolvedValue([]) },
    videoComment: { groupBy: jest.fn().mockResolvedValue(w.comments ?? []), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(async ({ data }: any) => ({ id: 'cm1', createdAt: new Date(NOW), ...data })), findUnique: jest.fn(), delete: jest.fn() },
    giftTransaction: { groupBy: jest.fn().mockResolvedValue(w.gifts ?? []) },
  };
  return { svc: new VideosService(prisma, { get: () => undefined } as any, {} as any), prisma };
}

describe('Explore feed tabs', () => {
  const list = [
    vid('a', { likeCount: 50, viewCount: 100 }),
    vid('b', { likeCount: 5, viewCount: 900, createdAt: new Date(NOW - 2 * 3600_000) }),
    vid('c', { likeCount: 200, viewCount: 10, createdAt: new Date(NOW - 10 * 24 * 3600_000) }), // old
  ];

  it('popular: most liked first, and pages with an offset', async () => {
    const { svc } = build({ videos: list });
    expect((await svc.feed('me', { tab: 'popular', limit: 10 })).map((v: any) => v.id)).toEqual(['c', 'a', 'b']);
    expect((await svc.feed('me', { tab: 'popular', limit: 1, offset: 1 })).map((v: any) => v.id)).toEqual(['a']);
  });

  it('hot: only the last week, trending ranked (a 2-hour-old video with lots of views beats a stale one)', async () => {
    const { svc } = build({ videos: list });
    const ids = (await svc.feed('me', { tab: 'hot' })).map((v: any) => v.id);
    expect(ids).not.toContain('c'); // 10 days old
    expect(ids).toHaveLength(2);
  });

  it('following: only creators you follow; nobody followed means an empty feed', async () => {
    const { svc } = build({ videos: list, follows: ['c-a'] });
    expect((await svc.feed('me', { tab: 'following' })).map((v: any) => v.id)).toEqual(['a']);
    expect(await build({ videos: list, follows: [] }).svc.feed('me', { tab: 'following' })).toEqual([]);
  });

  it('never shows videos from anyone you blocked or who blocked you', async () => {
    const { svc } = build({ videos: list, blocks: [['me', 'c-a'], ['c-b', 'me']] });
    expect((await svc.feed('me', { tab: 'popular' })).map((v: any) => v.id)).toEqual(['c']);
  });

  it('no tab keeps the newest-first behaviour, paged by timestamp', async () => {
    const { svc } = build({ videos: list });
    expect((await svc.feed('me', {})).map((v: any) => v.id)).toEqual(['a', 'b', 'c']);
    expect((await svc.feed('me', { before: new Date(NOW - 3600_000 - 1).toISOString() })).map((v: any) => v.id)).toEqual(['b', 'c']);
    await expect(svc.feed('me', { before: 'not-a-date' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('hotScore rewards likes, views and freshness', () => {
    const fresh = hotScore({ viewCount: 100, likeCount: 10, createdAt: new Date(NOW - 3600_000) }, NOW);
    const stale = hotScore({ viewCount: 100, likeCount: 10, createdAt: new Date(NOW - 100 * 3600_000) }, NOW);
    expect(fresh).toBeGreaterThan(stale);
    expect(hotScore({ viewCount: 0, likeCount: 1, createdAt: new Date(NOW) }, NOW)).toBeGreaterThan(hotScore({ viewCount: 2, likeCount: 0, createdAt: new Date(NOW) }, NOW));
  });
});

describe('what each video carries', () => {
  it('creator photo, whether you follow them, and real comment and gift counts', async () => {
    const { svc } = build({ videos: [vid('a', { creatorId: 'c-a' })], follows: ['c-a'], comments: [{ videoId: 'a', _count: { _all: 7 } }], gifts: [{ contextId: 'a', _count: { _all: 3 } }] });
    const [v]: any = await svc.feed('me', {});
    expect(v.creator).toEqual({ id: 'c-a', displayName: 'Ada', avatarUrl: 'https://x/a.jpg', followedByMe: true });
    expect(v).toMatchObject({ commentCount: 7, giftCount: 3, shareCount: 0, musicTitle: null });
  });
});

describe('comments', () => {
  it('a comment is trimmed, limited to 300 characters, and refused when empty', async () => {
    const { svc, prisma } = build({ videos: [vid('a')] });
    const c: any = await svc.addComment('me', 'a', '  nice   one  ');
    expect(prisma.videoComment.create.mock.calls[0][0].data.text).toBe('nice one');
    expect(c).toMatchObject({ mine: true, text: 'nice one' });
    await expect(svc.addComment('me', 'a', '   ')).rejects.toThrow(/Write something/);
    await expect(svc.addComment('me', 'a', 'x'.repeat(301))).rejects.toThrow(/300/);
    await expect(svc.addComment('me', 'nope', 'hi')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the author or the video creator can delete a comment; nobody else', async () => {
    const { svc, prisma } = build({ videos: [vid('a', { creatorId: 'owner' })] });
    prisma.videoComment.findUnique.mockResolvedValue({ id: 'cm1', videoId: 'a', userId: 'author' });
    await svc.deleteComment('author', 'a', 'cm1');
    await svc.deleteComment('owner', 'a', 'cm1');
    expect(prisma.videoComment.delete).toHaveBeenCalledTimes(2);
    await expect(svc.deleteComment('stranger', 'a', 'cm1')).rejects.toBeInstanceOf(ForbiddenException);
    prisma.videoComment.findUnique.mockResolvedValue({ id: 'cm1', videoId: 'other', userId: 'author' });
    await expect(svc.deleteComment('author', 'a', 'cm1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('search and share', () => {
  it('needs 2 to 50 characters, and ignores a leading #', async () => {
    const { svc, prisma } = build({ videos: [vid('a')] });
    await expect(svc.search('me', 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.search('me', 'x'.repeat(51))).rejects.toBeInstanceOf(BadRequestException);
    await svc.search('me', '#weekend');
    expect(JSON.stringify(prisma.video.findMany.mock.calls[0][0].where)).toContain('weekend');
    expect(JSON.stringify(prisma.video.findMany.mock.calls[0][0].where)).not.toContain('#weekend');
  });

  it('share counts up', async () => {
    const { svc } = build({ videos: [vid('a')] });
    expect(await svc.share('a')).toEqual({ shareCount: 4 });
  });
});
