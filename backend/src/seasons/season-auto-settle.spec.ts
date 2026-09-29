import { SeasonAutoSettleService } from './season-auto-settle.service';
import { SeasonsService } from './seasons.service';

// A minimal in-memory Prisma stand-in — same shape as seasons.spec.ts's build(), trimmed to
// just what sweep() and the real SeasonsService.settleSeason() it drives actually touch.
function build() {
  const seasons = new Map<string, any>();
  const participants = new Map<string, any>();
  const tiers = new Map<string, any[]>();
  let idCounter = 0;

  const prisma: any = {
    season: {
      findUnique: async ({ where }: any) => seasons.get(where.id) ?? null,
      findMany: async ({ where }: any) => {
        let rows = [...seasons.values()];
        if (where?.endsAt?.lt !== undefined) rows = rows.filter((s) => s.endsAt < where.endsAt.lt);
        if (where?.settledAt === null) rows = rows.filter((s) => s.settledAt === null);
        return rows;
      },
      update: async ({ where, data }: any) => { const s = seasons.get(where.id); Object.assign(s, data); return { ...s }; },
    },
    seasonParticipant: {
      findMany: async ({ where, orderBy }: any) => {
        let rows = [...participants.values()].filter((p) => p.seasonId === where.seasonId);
        if (orderBy?.points === 'desc') rows.sort((a, b) => b.points - a.points);
        return rows;
      },
    },
    seasonRewardTier: {
      findMany: async ({ where, orderBy }: any) => {
        const rows = tiers.get(where.seasonId) ?? [];
        if (orderBy?.minRank === 'asc') rows.sort((a, b) => a.minRank - b.minRank);
        return rows;
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };

  const seed = (over: Partial<any> = {}) => {
    const s = { id: `season-${++idCounter}`, name: 'S', description: null, settledAt: null, ...over };
    seasons.set(s.id, s);
    return s;
  };
  const seedParticipant = (seasonId: string, userId: string, points: number) => {
    participants.set(`${seasonId}|${userId}`, { seasonId, userId, points });
  };
  const seedTier = (seasonId: string, minRank: number, maxRank: number, rewardCoins: number) => {
    const list = tiers.get(seasonId) ?? [];
    list.push({ minRank, maxRank, rewardCoins });
    tiers.set(seasonId, list);
  };

  const wallet: any = { credit: jest.fn().mockResolvedValue(undefined) };
  const notifications: any = { notifyOnce: jest.fn().mockResolvedValue(undefined) };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };

  const seasonsSvc = new SeasonsService(prisma, wallet, notifications, audit);
  const sweeper = new SeasonAutoSettleService(prisma, seasonsSvc);

  return { sweeper, seasonsSvc, seasons, seed, seedParticipant, seedTier, wallet, notifications, audit };
}

const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600_000);

describe('SeasonAutoSettleService.sweep', () => {
  it('settles a season whose window has closed and is not yet settled', async () => {
    const { sweeper, seasons, seed } = build();
    const s = seed({ startsAt: day(-2), endsAt: day(-1) });

    const settledIds = await sweeper.sweep();

    expect(settledIds).toEqual([s.id]);
    expect(seasons.get(s.id).settledAt).not.toBeNull();
  });

  it('pays out through the real settlement path — reward tiers, wallet credit, and a winner notification', async () => {
    const { sweeper, seed, seedParticipant, seedTier, wallet, notifications } = build();
    const s = seed({ startsAt: day(-2), endsAt: day(-1) });
    seedParticipant(s.id, 'u1', 100);
    seedParticipant(s.id, 'u2', 50);
    seedTier(s.id, 1, 1, 500);

    await sweeper.sweep();

    expect(wallet.credit).toHaveBeenCalledTimes(1);
    expect(wallet.credit.mock.calls[0][0]).toMatchObject({ userId: 'u1', amount: BigInt(500) });
    expect(notifications.notifyOnce).toHaveBeenCalledTimes(1);
    expect(notifications.notifyOnce.mock.calls[0][0]).toBe('u1');
  });

  it('ignores a season that has not ended yet', async () => {
    const { sweeper, seasons, seed } = build();
    const s = seed({ startsAt: day(-1), endsAt: day(1) });

    expect(await sweeper.sweep()).toEqual([]);
    expect(seasons.get(s.id).settledAt).toBeNull();
  });

  it('ignores a season that is already settled', async () => {
    const { sweeper, seed } = build();
    seed({ startsAt: day(-2), endsAt: day(-1), settledAt: day(-1) });

    expect(await sweeper.sweep()).toEqual([]);
  });

  it('settles every other due season even when one fails to pay out', async () => {
    const { sweeper, seasons, seed, seedParticipant, seedTier, wallet } = build();
    const bad = seed({ startsAt: day(-3), endsAt: day(-2) });
    seedParticipant(bad.id, 'u1', 100);
    seedTier(bad.id, 1, 1, 500);
    const good = seed({ startsAt: day(-2), endsAt: day(-1) });
    seedParticipant(good.id, 'u2', 100);
    seedTier(good.id, 1, 1, 500);
    // bad's payout transaction fails (e.g. ledger unavailable); good's succeeds.
    wallet.credit.mockRejectedValueOnce(new Error('ledger unavailable'));

    const settled = await sweeper.sweep();

    expect(settled).toEqual([good.id]);
    expect(seasons.get(bad.id).settledAt).toBeNull(); // never marked settled — can be retried next sweep
    expect(seasons.get(good.id).settledAt).not.toBeNull();
  });

  it('never throws even if the database is unreachable', async () => {
    const prisma: any = { season: { findMany: async () => { throw new Error('db down'); } } };
    const seasonsSvc = new SeasonsService(prisma, {} as any, {} as any, {} as any);
    const sweeper = new SeasonAutoSettleService(prisma, seasonsSvc);
    await expect(sweeper.sweep()).resolves.toEqual([]);
  });

  it('does not run two sweeps concurrently', async () => {
    const { sweeper, seed } = build();
    seed({ startsAt: day(-2), endsAt: day(-1) });

    const [first, second] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    // One of the two calls finds the reentrancy guard already held and returns early.
    expect(first.length + second.length).toBe(1);
  });
});
