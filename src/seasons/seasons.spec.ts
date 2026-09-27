import { SeasonsService } from './seasons.service';

function build() {
  const seasons = new Map<string, any>();
  const participants = new Map<string, any>(); // key: seasonId|userId
  const tiers = new Map<string, any[]>(); // seasonId -> tiers
  let idCounter = 0;

  const prisma: any = {
    season: {
      findUnique: async ({ where }: any) => seasons.get(where.id) ?? null,
      findFirst: async ({ where, orderBy }: any) => {
        let rows = [...seasons.values()];
        if (where.startsAt?.lte !== undefined && where.endsAt?.gte !== undefined) {
          rows = rows.filter((s) => s.startsAt <= where.startsAt.lte && s.endsAt >= where.endsAt.gte);
        } else if (where.startsAt?.lt !== undefined && where.endsAt?.gt !== undefined) {
          // The overlap test createSeason() actually runs: two ranges overlap iff
          // s1 < e2 AND s2 < e1 — must be checked as its own case, not folded into the
          // lte/gte branch above, or a real overlap query silently matches every row.
          rows = rows.filter((s) => s.startsAt < where.startsAt.lt && s.endsAt > where.endsAt.gt);
        } else if (where.startsAt?.gt !== undefined) {
          rows = rows.filter((s) => s.startsAt > where.startsAt.gt);
        }
        rows.sort((a, b) => (orderBy.startsAt === 'asc' ? a.startsAt.getTime() - b.startsAt.getTime() : b.startsAt.getTime() - a.startsAt.getTime()));
        return rows[0] ?? null;
      },
      findMany: async ({ where, orderBy, cursor, skip, take }: any) => {
        let rows = [...seasons.values()];
        if (where?.startsAt?.lte && where?.endsAt?.gte) {
          rows = rows.filter((s) => s.startsAt <= where.startsAt.lte && s.endsAt >= where.endsAt.gte);
        }
        if (where?.startsAt?.lt && where?.endsAt?.gt) {
          rows = rows.filter((s) => s.startsAt < where.startsAt.lt && s.endsAt > where.endsAt.gt);
        }
        if (where?.settledAt?.not === null) rows = rows.filter((s) => s.settledAt !== null);
        if (orderBy?.startsAt === 'desc') rows.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
        if (orderBy?.endsAt === 'desc') rows.sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
        if (cursor?.id) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          rows = idx === -1 ? [] : rows.slice(idx + (skip ?? 0));
        }
        return take ? rows.slice(0, take) : rows;
      },
      create: async ({ data }: any) => { const s = { id: `season-${++idCounter}`, settledAt: null, createdAt: new Date(), ...data }; seasons.set(s.id, s); return s; },
      update: async ({ where, data }: any) => { const s = seasons.get(where.id); Object.assign(s, data); return { ...s }; },
    },
    seasonParticipant: {
      findUnique: async ({ where }: any) => participants.get(`${where.seasonId_userId.seasonId}|${where.seasonId_userId.userId}`) ?? null,
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = [...participants.values()].filter((p) => p.seasonId === where.seasonId);
        if (orderBy?.points === 'desc') rows.sort((a, b) => b.points - a.points);
        return take ? rows.slice(0, take) : rows;
      },
      count: async ({ where }: any) => [...participants.values()].filter((p) => p.seasonId === where.seasonId && (where.points?.gt === undefined || p.points > where.points.gt)).length,
      upsert: async ({ where, update, create }: any) => {
        const key = `${where.seasonId_userId.seasonId}|${where.seasonId_userId.userId}`;
        const existing = participants.get(key);
        if (existing) {
          if (update.points?.increment) existing.points += update.points.increment;
          return existing;
        }
        const p = { id: `participant-${++idCounter}`, joinedAt: new Date(), ...create };
        participants.set(key, p);
        return p;
      },
    },
    seasonRewardTier: {
      findMany: async ({ where, orderBy }: any) => {
        const rows = tiers.get(where.seasonId) ?? [];
        if (orderBy?.minRank === 'asc') rows.sort((a, b) => a.minRank - b.minRank);
        return rows;
      },
      deleteMany: async ({ where }: any) => { tiers.set(where.seasonId, []); },
      create: async ({ data }: any) => { const list = tiers.get(data.seasonId) ?? []; const t = { id: `tier-${++idCounter}`, ...data }; list.push(t); tiers.set(data.seasonId, list); return t; },
    },
    user: { findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id, displayName: id, avatarUrl: null })) },
    $transaction: async (fn: any) => fn(prisma),
  };

  const wallet: any = { credit: jest.fn().mockResolvedValue(undefined) };
  const notifications: any = { notifyOnce: jest.fn().mockResolvedValue(undefined) };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };

  return { svc: new SeasonsService(prisma, wallet, notifications, audit), seasons, participants, tiers, wallet, notifications };
}

const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600_000);

describe('SeasonsService.deriveStatus', () => {
  it('derives SCHEDULED, ACTIVE, ENDED, and SETTLED correctly', () => {
    const { svc } = build();
    const now = new Date('2026-06-15T00:00:00Z');
    expect(svc.deriveStatus({ startsAt: new Date('2026-07-01'), endsAt: new Date('2026-07-31'), settledAt: null }, now)).toBe('SCHEDULED');
    expect(svc.deriveStatus({ startsAt: new Date('2026-06-01'), endsAt: new Date('2026-06-30'), settledAt: null }, now)).toBe('ACTIVE');
    expect(svc.deriveStatus({ startsAt: new Date('2026-05-01'), endsAt: new Date('2026-05-31'), settledAt: null }, now)).toBe('ENDED');
    expect(svc.deriveStatus({ startsAt: new Date('2026-05-01'), endsAt: new Date('2026-05-31'), settledAt: new Date('2026-06-01') }, now)).toBe('SETTLED');
  });
});

describe('SeasonsService.contributePoints', () => {
  it('is a no-op when there is no active season', async () => {
    const { svc, participants } = build();
    await svc.contributePoints('u1', 50);
    expect(participants.size).toBe(0);
  });

  it('credits every currently active season, and only active ones', async () => {
    const { svc, seasons, participants } = build();
    const active = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Active Season', startsAt: day(-1), endsAt: day(1) });
    await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Future Season', startsAt: day(5), endsAt: day(10) });
    await svc.contributePoints('u1', 40);
    expect(participants.get(`${active.id}|u1`).points).toBe(40);
    expect(participants.size).toBe(1); // the future season got nothing
  });

  it('accumulates across repeated calls', async () => {
    const { svc, participants } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.contributePoints('u1', 20);
    await svc.contributePoints('u1', 30);
    expect(participants.get(`${s.id}|u1`).points).toBe(50);
  });

  it('ignores zero, negative, and NaN amounts', async () => {
    const { svc, participants } = build();
    await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.contributePoints('u1', 0);
    await svc.contributePoints('u1', -5);
    await svc.contributePoints('u1', NaN);
    expect(participants.size).toBe(0);
  });

  it('never throws even if the database is unreachable', async () => {
    const prisma: any = { season: { findMany: async () => { throw new Error('db down'); } } };
    const svc = new SeasonsService(prisma, {} as any, {} as any, {} as any);
    await expect(svc.contributePoints('u1', 50)).resolves.toBeUndefined();
  });
});

describe('SeasonsService reads', () => {
  it('currentOrNext prefers an active season over a future one', async () => {
    const { svc } = build();
    const active = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Now', startsAt: day(-1), endsAt: day(1) });
    await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Later', startsAt: day(5), endsAt: day(10) });
    const current = await svc.currentOrNext();
    expect(current).toMatchObject({ id: active.id, status: 'ACTIVE' });
  });

  it('currentOrNext falls back to the next scheduled season when none is active', async () => {
    const { svc } = build();
    const future = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Later', startsAt: day(5), endsAt: day(10) });
    const current = await svc.currentOrNext();
    expect(current).toMatchObject({ id: future.id, status: 'SCHEDULED' });
  });

  it('currentOrNext returns null when no season exists at all', async () => {
    const { svc } = build();
    expect(await svc.currentOrNext()).toBeNull();
  });

  it('seasonSnapshot reflects participant count, viewer rank, and reward tiers', async () => {
    const { svc } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [{ minRank: 1, maxRank: 1, rewardCoins: 5000 }]);
    await svc.contributePoints('u1', 100);
    await svc.contributePoints('u2', 50);
    const snap = await svc.seasonSnapshot(s.id, 'u2');
    expect(snap).toMatchObject({ participantCount: 2 });
    expect(snap!.viewer).toMatchObject({ points: 50, rank: 2 });
    expect(snap!.rewardTiers).toEqual([{ minRank: 1, maxRank: 1, rewardCoins: 5000 }]);
  });

  it('seasonSnapshot returns null for an unknown season', async () => {
    const { svc } = build();
    expect(await svc.seasonSnapshot('no-such-season', 'u1')).toBeNull();
  });

  it('listLeaderboard orders by points descending and respects the limit', async () => {
    const { svc } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.contributePoints('u1', 10);
    await svc.contributePoints('u2', 90);
    await svc.contributePoints('u3', 50);
    const board = await svc.listLeaderboard(s.id, 2);
    expect(board.map((r) => r.userId)).toEqual(['u2', 'u3']);
    expect(board[0].rank).toBe(1);
  });
});

describe('SeasonsService.createSeason', () => {
  it('rejects endsAt before startsAt', async () => {
    const { svc } = build();
    await expect(svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(1), endsAt: day(0) })).rejects.toThrow('after startsAt');
  });

  it('rejects an overlapping season', async () => {
    const { svc } = build();
    await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'A', startsAt: day(0), endsAt: day(10) });
    await expect(svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'B', startsAt: day(5), endsAt: day(15) })).rejects.toThrow('Overlaps');
  });

  it('rejects an empty name', async () => {
    const { svc } = build();
    await expect(svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: '  ', startsAt: day(0), endsAt: day(1) })).rejects.toThrow('required');
  });
});

describe('SeasonsService.setRewardTiers', () => {
  it('rejects overlapping tiers', async () => {
    const { svc } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await expect(svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [
      { minRank: 1, maxRank: 5, rewardCoins: 1000 },
      { minRank: 3, maxRank: 10, rewardCoins: 500 },
    ])).rejects.toThrow('overlap');
  });

  it('rejects a negative rewardCoins', async () => {
    const { svc } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await expect(svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [{ minRank: 1, maxRank: 1, rewardCoins: -1 }])).rejects.toThrow('non-negative');
  });

  it('replaces the whole tier list atomically', async () => {
    const { svc } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [{ minRank: 1, maxRank: 1, rewardCoins: 5000 }]);
    const replaced = await svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [{ minRank: 1, maxRank: 10, rewardCoins: 100 }]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ minRank: 1, maxRank: 10, rewardCoins: 100 });
  });
});

describe('SeasonsService.settleSeason', () => {
  it('refuses to settle before the season has ended', async () => {
    const { svc } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(5) });
    await expect(svc.settleSeason(s.id, 'admin', ['SUPER_ADMIN'] as any)).rejects.toThrow('not ended');
  });

  it('refuses to settle twice', async () => {
    const { svc } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-10), endsAt: day(-1) });
    await svc.settleSeason(s.id, 'admin', ['SUPER_ADMIN'] as any);
    await expect(svc.settleSeason(s.id, 'admin', ['SUPER_ADMIN'] as any)).rejects.toThrow('already been settled');
  });

  it('pays reward tiers by final rank, marks settled, and notifies each winner once', async () => {
    const { svc, seasons, wallet, notifications } = build();
    // Created as currently ACTIVE so contributePoints actually credits it, then pushed into the
    // past to simulate "time has now passed and it ended" — contributePoints only credits
    // seasons that are active AT THE MOMENT of contribution, same as it would for real.
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [
      { minRank: 1, maxRank: 1, rewardCoins: 5000 },
      { minRank: 2, maxRank: 3, rewardCoins: 1000 },
    ]);
    await svc.contributePoints('gold', 300);
    await svc.contributePoints('silver', 200);
    await svc.contributePoints('bronze', 150);
    await svc.contributePoints('nobody', 10);
    seasons.get(s.id).endsAt = day(-1); // now simulate the season having ended

    const result = await svc.settleSeason(s.id, 'admin', ['SUPER_ADMIN'] as any);
    expect(result).toMatchObject({ settled: true, paidOut: 3, totalParticipants: 4 });
    expect(wallet.credit).toHaveBeenCalledTimes(3);
    expect(notifications.notifyOnce).toHaveBeenCalledTimes(3);
    expect(notifications.notifyOnce).toHaveBeenCalledWith('gold', 'SEASON_REWARD', expect.any(String), expect.objectContaining({ rank: 1, rewardCoins: 5000 }));
    expect(seasons.get(s.id).settledAt).not.toBeNull();
  });

  it('never pays or notifies someone outside every configured tier', async () => {
    const { svc, seasons, wallet } = build();
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [{ minRank: 1, maxRank: 1, rewardCoins: 5000 }]);
    await svc.contributePoints('winner', 100);
    await svc.contributePoints('loser', 10);
    seasons.get(s.id).endsAt = day(-1);
    await svc.settleSeason(s.id, 'admin', ['SUPER_ADMIN'] as any);
    expect(wallet.credit).toHaveBeenCalledTimes(1);
  });
});

describe('SeasonsService.seasonHistory', () => {
  it('only ever returns settled seasons, never SCHEDULED/ACTIVE/ENDED ones', async () => {
    const { svc, seasons } = build();
    const settled = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Settled', startsAt: day(-10), endsAt: day(-5) });
    seasons.get(settled.id).endsAt = day(-5);
    await svc.settleSeason(settled.id, 'admin', ['SUPER_ADMIN'] as any);
    await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Active', startsAt: day(-1), endsAt: day(1) });
    await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Future', startsAt: day(5), endsAt: day(10) });

    const { seasons: result } = await svc.seasonHistory('anyone');
    expect(result.map((s) => s.name)).toEqual(['Settled']);
  });

  it("carries the viewer's own rank, points, and reward — never another participant's", async () => {
    const { svc, seasons } = build();
    // Same shape as the settleSeason tests above: created currently ACTIVE so contributePoints
    // actually credits it, then pushed into the past to simulate the season having ended.
    const s = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'S', startsAt: day(-1), endsAt: day(1) });
    await svc.setRewardTiers(s.id, 'admin', ['SUPER_ADMIN'] as any, [{ minRank: 1, maxRank: 1, rewardCoins: 5000 }]);
    await svc.contributePoints('winner', 300);
    await svc.contributePoints('runner-up', 100);
    seasons.get(s.id).endsAt = day(-1);
    await svc.settleSeason(s.id, 'admin', ['SUPER_ADMIN'] as any);

    const { seasons: forWinner } = await svc.seasonHistory('winner');
    expect(forWinner[0].viewer).toEqual({ points: 300, rank: 1, rewardCoins: 5000 });

    const { seasons: forRunnerUp } = await svc.seasonHistory('runner-up');
    expect(forRunnerUp[0].viewer).toEqual({ points: 100, rank: 2, rewardCoins: 0 }); // rank 2, outside the rewardCoins tier

    const { seasons: forStranger } = await svc.seasonHistory('never-participated');
    expect(forStranger[0].viewer).toEqual({ points: 0, rank: null, rewardCoins: 0 });
  });

  it('paginates with a cursor, most recently ended first', async () => {
    const { svc, seasons } = build();
    const older = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Older', startsAt: day(-1), endsAt: day(1) });
    seasons.get(older.id).endsAt = day(-15);
    await svc.settleSeason(older.id, 'admin', ['SUPER_ADMIN'] as any);
    const newer = await svc.createSeason('admin', ['SUPER_ADMIN'] as any, { name: 'Newer', startsAt: day(-1), endsAt: day(1) });
    seasons.get(newer.id).endsAt = day(-5);
    await svc.settleSeason(newer.id, 'admin', ['SUPER_ADMIN'] as any);

    const firstPage = await svc.seasonHistory('u1', undefined, 1);
    expect(firstPage.seasons.map((s) => s.name)).toEqual(['Newer']);
    expect(firstPage.nextCursor).toBe(newer.id);

    const secondPage = await svc.seasonHistory('u1', firstPage.nextCursor!, 1);
    expect(secondPage.seasons.map((s) => s.name)).toEqual(['Older']);
    expect(secondPage.nextCursor).toBeNull();
  });
});
