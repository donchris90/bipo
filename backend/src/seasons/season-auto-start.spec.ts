import { SeasonAutoStartService } from './season-auto-start.service';

function build() {
  const seasons = new Map<string, any>();
  let idCounter = 0;

  const prisma: any = {
    season: {
      findMany: async ({ where }: any) => {
        let rows = [...seasons.values()];
        if (where?.startsAt?.lte !== undefined) rows = rows.filter((s) => s.startsAt <= where.startsAt.lte);
        if (where?.startNotifiedAt === null) rows = rows.filter((s) => s.startNotifiedAt === null);
        return rows;
      },
      update: async ({ where, data }: any) => { const s = seasons.get(where.id); Object.assign(s, data); return { ...s }; },
    },
  };

  const seed = (over: Partial<any> = {}) => {
    const s = { id: `season-${++idCounter}`, name: 'S', startNotifiedAt: null, ...over };
    seasons.set(s.id, s);
    return s;
  };

  const push: any = { broadcastToAll: jest.fn().mockResolvedValue({ sent: 0 }) };
  const sweeper = new SeasonAutoStartService(prisma, push);

  return { sweeper, seasons, seed, push };
}

const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600_000);

describe('SeasonAutoStartService.sweep', () => {
  it('announces a season whose start time has arrived', async () => {
    const { sweeper, seasons, seed, push } = build();
    const s = seed({ startsAt: day(-1), endsAt: day(30) });

    const notified = await sweeper.sweep();

    expect(notified).toEqual([s.id]);
    expect(seasons.get(s.id).startNotifiedAt).not.toBeNull();
    expect(push.broadcastToAll).toHaveBeenCalledTimes(1);
    expect(push.broadcastToAll.mock.calls[0][0]).toMatchObject({ data: { seasonId: s.id } });
  });

  it('ignores a season that has not started yet', async () => {
    const { sweeper, seasons, seed, push } = build();
    const s = seed({ startsAt: day(1), endsAt: day(30) });

    expect(await sweeper.sweep()).toEqual([]);
    expect(seasons.get(s.id).startNotifiedAt).toBeNull();
    expect(push.broadcastToAll).not.toHaveBeenCalled();
  });

  it('never re-announces a season that has already been notified', async () => {
    const { sweeper, seed, push } = build();
    seed({ startsAt: day(-2), endsAt: day(30), startNotifiedAt: day(-2) });

    expect(await sweeper.sweep()).toEqual([]);
    expect(push.broadcastToAll).not.toHaveBeenCalled();
  });

  it('announces every other due season even when one broadcast fails', async () => {
    const { sweeper, seasons, seed, push } = build();
    const bad = seed({ startsAt: day(-2), endsAt: day(30) });
    const good = seed({ startsAt: day(-1), endsAt: day(30) });
    push.broadcastToAll.mockRejectedValueOnce(new Error('provider down'));

    const notified = await sweeper.sweep();

    expect(notified).toEqual([good.id]);
    expect(seasons.get(bad.id).startNotifiedAt).toBeNull(); // retried next sweep
    expect(seasons.get(good.id).startNotifiedAt).not.toBeNull();
  });

  it('never throws even if the database is unreachable', async () => {
    const prisma: any = { season: { findMany: async () => { throw new Error('db down'); } } };
    const sweeper = new SeasonAutoStartService(prisma, { broadcastToAll: jest.fn() } as any);
    await expect(sweeper.sweep()).resolves.toEqual([]);
  });

  it('does not run two sweeps concurrently', async () => {
    const { sweeper, seed } = build();
    seed({ startsAt: day(-1), endsAt: day(30) });

    const [first, second] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(first.length + second.length).toBe(1);
  });
});
