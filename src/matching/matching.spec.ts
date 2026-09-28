import { MatchingService, TICKET_TTL_MS } from './matching.service';

// ---- A small in-memory Prisma double covering exactly the queries MatchingService issues -------

function matchValue(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    if ('not' in cond && actual === cond.not) return false;
    if ('notIn' in cond && cond.notIn.includes(actual)) return false;
    if ('in' in cond && !cond.in.includes(actual)) return false;
    if ('lt' in cond && !(actual < cond.lt)) return false;
    if ('gte' in cond && !(actual >= cond.gte)) return false;
    return true;
  }
  return actual === cond;
}

function matchWhere(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as any[]).some((w) => matchWhere(row, w));
    return matchValue(row[key], cond);
  });
}

function build(users: Record<string, { countryCode?: string; status?: string; displayName?: string | null }> = {}) {
  const tickets = new Map<string, any>();
  const sessions = new Map<string, any>();
  const blocks: Array<{ blockerId: string; blockedId: string }> = [];
  const follows: Array<{ followerId: string; followingId: string }> = [];
  let idn = 0;
  const emitted: Array<{ userId: string; event: string; payload: any }> = [];

  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => {
        const u = users[where.id] ?? { countryCode: 'NG', status: 'ACTIVE', displayName: where.id };
        return { status: 'ACTIVE', countryCode: 'NG', avatarUrl: null, ...u };
      },
    },
    block: {
      findMany: async ({ where }: any) => blocks.filter((b) => matchWhere(b, where)),
      findFirst: async ({ where }: any) => blocks.find((b) => matchWhere(b, where)) ?? null,
    },
    follow: {
      createMany: async ({ data }: any) => {
        for (const d of data) if (!follows.some((f) => f.followerId === d.followerId && f.followingId === d.followingId)) follows.push(d);
      },
    },
    matchTicket: {
      findUnique: async ({ where }: any) => [...tickets.values()].find((t) => (where.userId ? t.userId === where.userId : t.id === where.id)) ?? null,
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = [...tickets.values()].filter((t) => matchWhere(t, where));
        if (orderBy?.createdAt === 'asc') rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.userId.localeCompare(b.userId));
        return take ? rows.slice(0, take) : rows;
      },
      upsert: async ({ where, update, create }: any) => {
        const existing = tickets.get(where.userId);
        if (existing) { Object.assign(existing, update); return existing; }
        const t = { id: `t${++idn}`, status: 'WAITING', sessionId: null, createdAt: new Date(), lastSeenAt: new Date(), ...create };
        tickets.set(t.userId, t);
        return t;
      },
      update: async ({ where, data }: any) => {
        const t = where.userId ? tickets.get(where.userId) : [...tickets.values()].find((x) => x.id === where.id);
        Object.assign(t, data);
        return t;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = [...tickets.values()].filter((t) => matchWhere(t, where));
        rows.forEach((t) => Object.assign(t, data));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: any) => {
        const rows = [...tickets.values()].filter((t) => matchWhere(t, where));
        rows.forEach((t) => tickets.delete(t.userId));
        return { count: rows.length };
      },
    },
    matchSession: {
      create: async ({ data }: any) => {
        const s = { id: `s${++idn}`, status: 'ACTIVE', aLiked: false, bLiked: false, createdAt: new Date(), endedAt: null, endedById: null, ...data };
        sessions.set(s.id, s);
        return { ...s };
      },
      findUnique: async ({ where }: any) => (sessions.get(where.id) ? { ...sessions.get(where.id) } : null),
      findFirst: async ({ where }: any) => {
        const row = [...sessions.values()].filter((s) => matchWhere(s, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: any) => { Object.assign(sessions.get(where.id), data); return { ...sessions.get(where.id) }; },
      updateMany: async ({ where, data }: any) => {
        const rows = [...sessions.values()].filter((s) => matchWhere(s, where));
        rows.forEach((s) => Object.assign(s, data));
        return { count: rows.length };
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };

  const rtc: any = {
    createChannel: jest.fn(async (name: string) => ({ channelName: name })),
    generateToken: jest.fn(async () => 'token-abc'),
    destroyChannel: jest.fn(async () => undefined),
  };
  const realtime: any = { emitToUser: (userId: string, event: string, payload: any) => emitted.push({ userId, event, payload }) };

  return { svc: new MatchingService(prisma, rtc, realtime), tickets, sessions, blocks, follows, rtc, emitted };
}

// Two joins in the same millisecond would tie on createdAt; the userId tie-break still decides,
// but ordering by real time keeps these tests reading like real life.
const tick = () => new Promise((r) => setTimeout(r, 3));

describe('MatchingService pairing', () => {
  it('pairs two waiting people into one session with a fresh channel', async () => {
    const { svc, rtc } = build();
    expect(await svc.join('alice')).toEqual({ status: 'SEARCHING' });
    await tick();
    const bob = await svc.join('bob');
    expect(bob.status).toBe('MATCHED');
    expect(rtc.createChannel).toHaveBeenCalledTimes(1);
    const alice = await svc.status('alice');
    expect(alice.status).toBe('MATCHED');
    expect((alice as any).session.id).toBe((bob as any).session.id);
    expect((alice as any).session.otherUserId).toBe('bob');
    expect((bob as any).session.otherUserId).toBe('alice');
  });

  it('tells the person who was already waiting, instantly, over the socket', async () => {
    const { svc, emitted } = build();
    await svc.join('alice');
    await tick();
    await svc.join('bob');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ userId: 'alice', event: 'match:found' });
  });

  it('keeps a lone third person searching rather than double-booking anyone', async () => {
    const { svc, sessions } = build();
    await svc.join('alice');
    await tick();
    await svc.join('bob');
    await tick();
    expect(await svc.join('carol')).toEqual({ status: 'SEARCHING' });
    expect(sessions.size).toBe(1);
  });

  it('creates exactly ONE session when two people join at the very same moment', async () => {
    const { svc, sessions } = build();
    await Promise.all([svc.join('alice'), svc.join('bob')]);
    // Whichever poll ran second may need one more pass to see the session.
    const [a, b] = await Promise.all([svc.status('alice'), svc.status('bob')]);
    expect(sessions.size).toBe(1);
    expect(a.status).toBe('MATCHED');
    expect(b.status).toBe('MATCHED');
  });

  it('a waiting person who polls again does not create a second session', async () => {
    const { svc, sessions } = build();
    await svc.join('alice');
    await tick();
    await svc.join('bob');
    await svc.status('alice');
    await svc.status('alice');
    expect(sessions.size).toBe(1);
  });

  it('never pairs people where either has blocked the other', async () => {
    const { svc, blocks, sessions } = build();
    blocks.push({ blockerId: 'bob', blockedId: 'alice' });
    await svc.join('alice');
    await tick();
    expect(await svc.join('bob')).toEqual({ status: 'SEARCHING' });
    expect(sessions.size).toBe(0);
  });

  it('respects same-country-only from either side', async () => {
    const { svc, sessions } = build({ alice: { countryCode: 'NG' }, bob: { countryCode: 'GH' } });
    await svc.join('alice', true);
    await tick();
    expect(await svc.join('bob', false)).toEqual({ status: 'SEARCHING' });
    expect(sessions.size).toBe(0);

    const second = build({ alice: { countryCode: 'NG' }, bob: { countryCode: 'GH' } });
    await second.svc.join('alice', false);
    await tick();
    expect(await second.svc.join('bob', true)).toEqual({ status: 'SEARCHING' });
  });

  it('pairs across countries when nobody asked for same-country only', async () => {
    const { svc } = build({ alice: { countryCode: 'NG' }, bob: { countryCode: 'GH' } });
    await svc.join('alice');
    await tick();
    expect((await svc.join('bob')).status).toBe('MATCHED');
  });

  it('ignores a waiting ticket that has gone quiet (app closed)', async () => {
    const { svc, tickets } = build();
    await svc.join('alice');
    tickets.get('alice').lastSeenAt = new Date(Date.now() - TICKET_TTL_MS - 1000);
    await tick();
    expect(await svc.join('bob')).toEqual({ status: 'SEARCHING' });
  });

  it('will not let a suspended account into the queue', async () => {
    const { svc } = build({ alice: { status: 'SUSPENDED' } });
    await expect(svc.join('alice')).rejects.toThrow('cannot use Match');
  });

  it('cancel removes a waiting ticket, so nobody can be paired with them', async () => {
    const { svc } = build();
    await svc.join('alice');
    expect(await svc.cancel('alice')).toEqual({ cancelled: true });
    await tick();
    expect(await svc.join('bob')).toEqual({ status: 'SEARCHING' });
    expect(await svc.status('nobody')).toEqual({ status: 'IDLE' });
  });

  it('shows a readable name for someone with no display name, never "Guest"', async () => {
    const { svc } = build({ alice: { displayName: null } });
    await svc.join('alice');
    await tick();
    const bob: any = await svc.join('bob');
    expect(bob.session.otherDisplayName.startsWith('User ')).toBe(true);
  });
});

describe('MatchingService sessions', () => {
  async function matched() {
    const ctx = build();
    await ctx.svc.join('alice');
    await tick();
    const bob: any = await ctx.svc.join('bob');
    return { ...ctx, sessionId: bob.session.id as string };
  }

  it('like is one-sided until the other person likes back, and hides their like until then', async () => {
    const { svc, sessionId } = await matched();
    expect(await svc.like(sessionId, 'alice')).toEqual({ mutual: false });
    expect(await svc.sessionState(sessionId, 'bob')).toMatchObject({ iLiked: false, mutual: false });
    expect(await svc.sessionState(sessionId, 'alice')).toMatchObject({ iLiked: true, mutual: false });
  });

  it('a mutual like makes them follow each other and pings the other person', async () => {
    const { svc, sessionId, follows, emitted } = await matched();
    await svc.like(sessionId, 'alice');
    expect(await svc.like(sessionId, 'bob')).toEqual({ mutual: true });
    expect(follows).toHaveLength(2);
    expect(emitted.some((e) => e.userId === 'alice' && e.event === 'match:mutual')).toBe(true);
  });

  it('liking twice does not create duplicate follows', async () => {
    const { svc, sessionId, follows } = await matched();
    await svc.like(sessionId, 'alice');
    await svc.like(sessionId, 'bob');
    await svc.like(sessionId, 'bob');
    expect(follows).toHaveLength(2);
  });

  it('skips the follow if one of them blocked the other mid-call', async () => {
    const { svc, sessionId, follows, blocks } = await matched();
    await svc.like(sessionId, 'alice');
    blocks.push({ blockerId: 'alice', blockedId: 'bob' });
    expect(await svc.like(sessionId, 'bob')).toEqual({ mutual: true });
    expect(follows).toHaveLength(0);
  });

  it('ending frees both people, destroys the channel once, and tells the other side', async () => {
    const { svc, sessionId, rtc, emitted, tickets } = await matched();
    expect(await svc.end(sessionId, 'alice')).toEqual({ ended: true });
    await svc.end(sessionId, 'bob'); // both hanging up together must not double-destroy
    expect(rtc.destroyChannel).toHaveBeenCalledTimes(1);
    expect(emitted.filter((e) => e.event === 'match:ended')).toHaveLength(1);
    expect(emitted.find((e) => e.event === 'match:ended')).toMatchObject({ userId: 'bob' });
    expect(tickets.size).toBe(0);
    expect(await svc.status('alice')).toEqual({ status: 'IDLE' });
  });

  it('joining the queue again ("Next") ends the current match and notifies the other person', async () => {
    const { svc, sessionId, sessions, emitted } = await matched();
    await tick();
    expect(await svc.join('alice')).toEqual({ status: 'SEARCHING' });
    expect(sessions.get(sessionId).status).toBe('ENDED');
    expect(emitted.some((e) => e.userId === 'bob' && e.event === 'match:ended')).toBe(true);
  });

  it('hands out a publish token only to a member of an active match', async () => {
    const { svc, sessionId } = await matched();
    expect(await svc.joinToken(sessionId, 'alice')).toMatchObject({ token: 'token-abc' });
    await expect(svc.joinToken(sessionId, 'mallory')).rejects.toThrow();
    await svc.end(sessionId, 'alice');
    await expect(svc.joinToken(sessionId, 'bob')).rejects.toThrow('has ended');
  });

  it('refuses to show or change a match to someone who is not in it', async () => {
    const { svc, sessionId } = await matched();
    await expect(svc.sessionState(sessionId, 'mallory')).rejects.toThrow();
    await expect(svc.like(sessionId, 'mallory')).rejects.toThrow();
    await expect(svc.end(sessionId, 'mallory')).rejects.toThrow();
    await expect(svc.sessionState('no-such-session', 'alice')).rejects.toThrow('not found');
  });
});
