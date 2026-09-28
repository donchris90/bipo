import { OnboardingService } from './onboarding.service';

const INTERESTS = [
  { key: 'MUSIC', label: 'Music', emoji: '🎵', active: true },
  { key: 'GAMING', label: 'Gaming', emoji: '🎮', active: true },
  { key: 'COMEDY', label: 'Comedy', emoji: '😂', active: true },
  { key: 'OLD', label: 'Retired', emoji: '🗑️', active: false },
];

function build(opts: {
  users?: Array<{ id: string; hostXp: number; isCreator: boolean; onboardedAt?: Date | null }>;
  following?: string[];
  sessions?: Array<{ hostId: string; category: string; startedAt: Date }>;
} = {}) {
  const users = new Map((opts.users ?? [{ id: 'me', hostXp: 0, isCreator: false, onboardedAt: null }]).map((u) => [u.id, { onboardedAt: null, ...u }]));
  const picked = new Map<string, string[]>();
  const following = new Set(opts.following ?? []);

  const inList = (list: any, id: string) => !list || list.includes(id);

  const prisma: any = {
    interest: {
      findMany: async ({ where }: any) => INTERESTS.filter((i) => (where?.active === undefined || i.active === where.active) && (!where?.key?.in || where.key.in.includes(i.key))),
    },
    userInterest: {
      findMany: async ({ where, include }: any) =>
        (picked.get(where.userId) ?? []).map((key) => ({ interestKey: key, ...(include ? { interest: { label: INTERESTS.find((i) => i.key === key)!.label } } : {}) })),
      deleteMany: async ({ where }: any) => { picked.set(where.userId, []); },
      create: async ({ data }: any) => { picked.set(data.userId, [...(picked.get(data.userId) ?? []), data.interestKey]); },
    },
    follow: { findMany: async () => [...following].map((followingId) => ({ followingId })) },
    liveSession: {
      findMany: async ({ where }: any) => {
        const labels: string[] = where.OR.map((c: any) => c.category.contains.toLowerCase());
        return (opts.sessions ?? []).filter((s) => s.startedAt >= where.startedAt.gte && labels.some((l) => s.category.toLowerCase().includes(l))).map((s) => ({ hostId: s.hostId }));
      },
    },
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
      update: async ({ where, data }: any) => { Object.assign(users.get(where.id)!, data); return users.get(where.id); },
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = [...users.values()].filter((u) => u.isCreator && !where.id.notIn?.includes(u.id) && inList(where.id.in, u.id));
        if (orderBy?.hostXp === 'desc') rows.sort((a, b) => b.hostXp - a.hostXp);
        return rows.slice(0, take).map((u) => ({ id: u.id, displayName: u.id, avatarUrl: null, bio: null, hostLevel: 1 }));
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { svc: new OnboardingService(prisma), picked, users };
}

describe('OnboardingService.setInterests', () => {
  it('requires at least one interest', async () => {
    const { svc } = build();
    await expect(svc.setInterests('me', [])).rejects.toThrow('at least one');
    await expect(svc.setInterests('me', undefined)).rejects.toThrow('at least one');
  });

  it('rejects an unknown or retired interest, naming it', async () => {
    const { svc } = build();
    await expect(svc.setInterests('me', ['MUSIC', 'NOPE'])).rejects.toThrow('NOPE');
    await expect(svc.setInterests('me', ['OLD'])).rejects.toThrow('OLD');
  });

  it('rejects more than ten', async () => {
    const { svc } = build();
    const many = Array.from({ length: 11 }, (_, i) => `K${i}`);
    await expect(svc.setInterests('me', many)).rejects.toThrow('at most');
  });

  it('replaces the previous selection instead of adding to it, and dedupes', async () => {
    const { svc, picked } = build();
    await svc.setInterests('me', ['MUSIC', 'GAMING']);
    await svc.setInterests('me', ['COMEDY', 'COMEDY']);
    expect(picked.get('me')).toEqual(['COMEDY']);
  });
});

describe('OnboardingService status and completion', () => {
  it('reports not completed with the interests picked so far, so the flow can resume', async () => {
    const { svc } = build();
    await svc.setInterests('me', ['MUSIC']);
    expect(await svc.status('me')).toEqual({ completed: false, interests: ['MUSIC'] });
  });

  it('completing is idempotent and keeps the original timestamp', async () => {
    const { svc } = build();
    const first = await svc.complete('me');
    const second = await svc.complete('me');
    expect(second.onboardedAt).toEqual(first.onboardedAt);
    expect((await svc.status('me')).completed).toBe(true);
  });

  it('only lists active interests', async () => {
    const { svc } = build();
    const list = await svc.listInterests();
    expect(list.map((i: any) => i.key)).toEqual(['MUSIC', 'GAMING', 'COMEDY']);
  });
});

describe('OnboardingService.suggestedCreators', () => {
  const recent = new Date();
  const users = [
    { id: 'me', hostXp: 0, isCreator: true },
    { id: 'bigStar', hostXp: 9000, isCreator: true },
    { id: 'gamer', hostXp: 100, isCreator: true },
    { id: 'followed', hostXp: 5000, isCreator: true },
    { id: 'viewer', hostXp: 0, isCreator: false },
  ];

  it('never suggests yourself, people you already follow, or non-creators', async () => {
    const { svc } = build({ users, following: ['followed'] });
    const ids = (await svc.suggestedCreators('me')).map((c: any) => c.id);
    expect(ids).toEqual(['bigStar', 'gamer']);
  });

  it('puts creators who recently streamed in a matching category first, then fills with the biggest', async () => {
    const { svc } = build({ users, sessions: [{ hostId: 'gamer', category: 'Gaming night', startedAt: recent }] });
    await svc.setInterests('me', ['GAMING']);
    const ids = (await svc.suggestedCreators('me', 10)).map((c: any) => c.id);
    expect(ids[0]).toBe('gamer');
    expect(ids).toEqual(['gamer', 'bigStar', 'followed']);
  });

  it('ignores category matches from long ago', async () => {
    const old = new Date(Date.now() - 90 * 24 * 3600_000);
    const { svc } = build({ users, sessions: [{ hostId: 'gamer', category: 'Gaming', startedAt: old }] });
    await svc.setInterests('me', ['GAMING']);
    const ids = (await svc.suggestedCreators('me')).map((c: any) => c.id);
    expect(ids[0]).toBe('bigStar');
  });

  it('respects the limit and clamps silly values', async () => {
    const { svc } = build({ users });
    expect(await svc.suggestedCreators('me', 1)).toHaveLength(1);
    expect((await svc.suggestedCreators('me', 9999)).length).toBe(3);
  });
});
