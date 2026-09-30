import { RoomPkService } from './room-pk.service';
import { applyRoomPkScore } from '../economy/room-pk-score';

// In-memory stand-in for the few Prisma calls Room PK makes, so the real service and the real gift
// hook run end to end. It understands exactly the where-shapes those two files use.
function makeDb() {
  const t = { rooms: [] as any[], seats: [] as any[], pks: [] as any[], parts: [] as any[], users: [] as any[], cfg: [] as any[] };
  let n = 0;
  const cmp = (v: any, c: any): boolean => {
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      if ('gt' in c && !(v > c.gt)) return false;
      if ('gte' in c && !(v >= c.gte)) return false;
      if ('lte' in c && !(v <= c.lte)) return false;
      if ('in' in c && !c.in.includes(v)) return false;
      return true;
    }
    return v === c;
  };
  const match = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, c]: [string, any]) => {
      if (k === 'OR') return c.some((w: any) => match(row, w));
      if (k === 'roomPk') return match(t.pks.find((p) => p.id === row.roomPkId) ?? {}, c);
      return cmp(row[k], c);
    });
  const pick = (row: any, select?: any) => (row && select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);
  const bump = (row: any, data: any) => {
    for (const [k, v] of Object.entries<any>(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
  };
  const db: any = {
    _t: t,
    partyRoom: {
      findUnique: async ({ where }: any) => t.rooms.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: any) => t.rooms.filter((r) => match(r, where)),
    },
    roomSeat: {
      findMany: async ({ where }: any) => t.seats.filter((r) => match(r, where)),
      findFirst: async ({ where }: any) => t.seats.find((r) => match(r, where)) ?? null,
    },
    user: { findMany: async ({ where }: any) => t.users.filter((u) => match(u, where)) },
    pKScoreConfig: { findFirst: async () => t.cfg[0] ?? null },
    roomPk: {
      findFirst: async ({ where, select }: any) => pick(t.pks.filter((r) => match(r, where)).sort((a, b) => +b.startedAt - +a.startedAt)[0] ?? null, select),
      findMany: async ({ where, select }: any) => t.pks.filter((r) => match(r, where)).map((r) => pick(r, select)),
      findUnique: async ({ where, include }: any) => {
        const r = t.pks.find((x) => x.id === where.id);
        return r ? (include ? { ...r, participants: t.parts.filter((p) => p.roomPkId === r.id) } : r) : null;
      },
      create: async ({ data }: any) => {
        const { participants, ...rest } = data;
        const row = { id: `pk${++n}`, status: 'ACTIVE', startedAt: new Date(), settledAt: null, winnerUserId: null, winnerSide: null, ...rest };
        t.pks.push(row);
        for (const p of participants.create) t.parts.push({ id: `pp${++n}`, roomPkId: row.id, score: 0n, ...p });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = t.pks.filter((r) => match(r, where));
        rows.forEach((r) => bump(r, data));
        return { count: rows.length };
      },
      update: async ({ where, data }: any) => {
        const r = t.pks.find((x) => x.id === where.id);
        bump(r, data);
        return r;
      },
    },
    roomPkParticipant: {
      findMany: async ({ where }: any) => t.parts.filter((r) => match(r, where)),
      updateMany: async ({ where, data }: any) => {
        const rows = t.parts.filter((r) => match(r, where));
        rows.forEach((r) => bump(r, data));
        return { count: rows.length };
      },
    },
    $transaction: async (cb: any) => cb(db),
  };
  return db;
}

const HOST = 'host';
function setup(seatUsers: string[] = [HOST, 'g1', 'g2']) {
  const db = makeDb();
  db._t.rooms.push({ id: 'r1', hostId: HOST, status: 'OPEN' });
  seatUsers.forEach((userId, seatNumber) => db._t.seats.push({ id: `s${seatNumber}`, roomId: 'r1', userId, seatNumber }));
  const events: any[] = [];
  const realtime = { broadcastRoomState: (_id: string, payload: any) => events.push(payload) };
  return { db, events, svc: new RoomPkService(db as any, realtime as any) };
}
const score = (db: any, userId: string) => db._t.parts.find((p: any) => p.userId === userId)?.score;
// start() opens with a 10s get-ready countdown; tests that need the battle underway skip past it.
const skipCountdown = (db: any) => { db._t.pks[0].startedAt = new Date(Date.now() - 1000); };

describe('RoomPkService', () => {
  it('only the host can start, and only in an open room', async () => {
    const { svc, db } = setup();
    await expect(svc.start('r1', 'g1')).rejects.toThrow(/Only the host/);
    db._t.rooms[0].status = 'CLOSED';
    await expect(svc.start('r1', HOST)).rejects.toThrow(/closed/);
    await expect(svc.start('nope', HOST)).rejects.toThrow(/not found/);
  });

  it('needs two seated people and refuses a second PK while one runs', async () => {
    const solo = setup([HOST]);
    await expect(solo.svc.start('r1', HOST)).rejects.toThrow(/At least 2/);
    const { svc } = setup();
    await svc.start('r1', HOST);
    await expect(svc.start('r1', HOST)).rejects.toThrow(/already running/);
  });

  it('starts with every seated person as a participant and announces it', async () => {
    const { svc, db, events } = setup();
    const state = await svc.start('r1', HOST, { mode: 'TEAMS', durationSec: 300 });
    expect(state.participants.map((p) => [p.userId, p.side])).toEqual([[HOST, 'A'], ['g1', 'B'], ['g2', 'A']]);
    expect(state.durationSec).toBe(300);
    expect(db._t.parts).toHaveLength(3);
    expect(events[0]).toMatchObject({ action: 'ROOM_PK_STARTED', roomId: 'r1' });
  });

  it('a gift to a seated participant scores; a non-participant or unseated person does not', async () => {
    const { svc, db } = setup();
    await svc.start('r1', HOST);
    skipCountdown(db);
    await applyRoomPkScore(db, 'r1', 'g1', 50);
    expect(score(db, 'g1')).toBe(50n);
    await applyRoomPkScore(db, 'r1', 'stranger', 50); // never a participant
    expect(db._t.parts.every((p: any) => p.userId === 'g1' || p.score === 0n)).toBe(true);
    db._t.seats = db._t.seats.filter((s: any) => s.userId !== 'g1'); // g1 steps away
    await applyRoomPkScore(db, 'r1', 'g1', 50);
    expect(score(db, 'g1')).toBe(50n); // frozen, not zeroed
  });

  it('uses the configured coins-per-point ratio', async () => {
    const { svc, db } = setup();
    db._t.cfg.push({ coinsPerPoint: 10 });
    await svc.start('r1', HOST);
    skipCountdown(db);
    await applyRoomPkScore(db, 'r1', 'g2', 95);
    expect(score(db, 'g2')).toBe(9n);
  });

  it('gifts after the buzzer, or with no PK running, change nothing', async () => {
    const { svc, db } = setup();
    await applyRoomPkScore(db, 'r1', 'g1', 50); // no PK yet
    expect(db._t.parts).toHaveLength(0);
    await svc.start('r1', HOST);
    skipCountdown(db);
    db._t.pks[0].endsAt = new Date(Date.now() - 500);
    await applyRoomPkScore(db, 'r1', 'g1', 50);
    expect(score(db, 'g1')).toBe(0n);
  });

  it('settles INDIVIDUAL by highest score once due, and only once', async () => {
    const { svc, db, events } = setup();
    const { id } = await svc.start('r1', HOST);
    skipCountdown(db);
    await applyRoomPkScore(db, 'r1', 'g1', 10);
    await applyRoomPkScore(db, 'r1', 'g2', 40);
    expect((await svc.settleIfDue(id)).status).toBe('ACTIVE'); // not due yet
    db._t.pks[0].endsAt = new Date(Date.now() - 1);
    const done = await svc.settleIfDue(id);
    expect(done.status).toBe('SETTLED');
    expect(done.winnerUserId).toBe('g2');
    await svc.settleIfDue(id);
    expect(events.filter((e) => e.action === 'ROOM_PK_SETTLED')).toHaveLength(1);
    await applyRoomPkScore(db, 'r1', 'g1', 999); // after settle: ignored
    expect(score(db, 'g1')).toBe(10n);
  });

  it('settles TEAMS by pooled total', async () => {
    const { svc, db } = setup([HOST, 'g1', 'g2', 'g3']);
    const { id } = await svc.start('r1', HOST, { mode: 'TEAMS' }); // A: host,g2  B: g1,g3
    skipCountdown(db);
    await applyRoomPkScore(db, 'r1', HOST, 100);
    await applyRoomPkScore(db, 'r1', 'g1', 60);
    await applyRoomPkScore(db, 'r1', 'g3', 60);
    const done = await svc.end('r1', HOST);
    expect(done.id).toBe(id);
    expect(done.winnerSide).toBe('B');
    expect(done.sideTotals).toEqual({ A: '100', B: '120' });
  });

  it('only the host can end early', async () => {
    const { svc } = setup();
    await svc.start('r1', HOST);
    await expect(svc.end('r1', 'g1')).rejects.toThrow(/Only the host/);
  });

  it('sweep settles due PKs and cancels one whose room closed', async () => {
    const { svc, db, events } = setup();
    await svc.start('r1', HOST);
    db._t.pks[0].endsAt = new Date(Date.now() - 1);
    await svc.sweep();
    expect(db._t.pks[0].status).toBe('SETTLED');

    const other = setup();
    await other.svc.start('r1', HOST);
    other.db._t.rooms[0].status = 'CLOSED';
    await other.svc.sweep();
    expect(other.db._t.pks[0].status).toBe('CANCELLED');
    expect(other.events.some((e) => e.action === 'ROOM_PK_CANCELLED')).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it('current() shows a running PK, a just-finished one, then nothing', async () => {
    const { svc, db } = setup();
    expect(await svc.current('r1')).toBeNull();
    await svc.start('r1', HOST);
    skipCountdown(db);
    expect((await svc.current('r1'))?.status).toBe('ACTIVE');
    await svc.end('r1', HOST);
    expect((await svc.current('r1'))?.status).toBe('SETTLED');
    db._t.pks[0].settledAt = new Date(Date.now() - 60_000);
    expect(await svc.current('r1')).toBeNull();
  });

  describe('get-ready countdown', () => {
    it('starts in COUNTDOWN with startedAt ~10s ahead and the battle length after that', async () => {
      const { svc } = setup();
      const before = Date.now();
      const state = await svc.start('r1', HOST, { durationSec: 300 });
      expect(state.phase).toBe('COUNTDOWN');
      const lead = new Date(state.startedAt).getTime() - before;
      expect(lead).toBeGreaterThanOrEqual(9_900);
      expect(lead).toBeLessThanOrEqual(11_000);
      expect(new Date(state.endsAt).getTime() - new Date(state.startedAt).getTime()).toBe(300_000);
    });

    it('gifts sent during the countdown do not count; the first one after it does', async () => {
      const { svc, db } = setup();
      await svc.start('r1', HOST);
      await applyRoomPkScore(db, 'r1', 'g1', 100);
      expect(score(db, 'g1')).toBe(0n);
      skipCountdown(db);
      await applyRoomPkScore(db, 'r1', 'g1', 100);
      expect(score(db, 'g1')).toBe(100n);
    });

    it('the host ending during the countdown cancels it: no winner, no result screen', async () => {
      const { svc, db, events } = setup();
      await svc.start('r1', HOST);
      const state = await svc.end('r1', HOST);
      expect(state.status).toBe('CANCELLED');
      expect(state.winnerUserId).toBeNull();
      expect(events.some((e) => e.action === 'ROOM_PK_CANCELLED')).toBe(true);
      expect(events.some((e) => e.action === 'ROOM_PK_SETTLED')).toBe(false);
      expect(await svc.current('r1')).toBeNull();
      // and a new one can be started straight away
      db._t.pks[0].status = 'CANCELLED';
      await expect(svc.start('r1', HOST)).resolves.toBeTruthy();
    });

    it('the reaper does not settle a PK that is still counting down', async () => {
      const { svc, db } = setup();
      await svc.start('r1', HOST);
      await svc.sweep();
      expect(db._t.pks[0].status).toBe('ACTIVE');
    });
  });
});
