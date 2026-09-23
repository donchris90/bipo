import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CHALLENGE_TTL_MS, PkService, RESULT_MS } from './pk.service';

interface World {
  online?: string[];
  follows?: [string, string][]; // [follower, following]
  blocks?: [string, string][];
  busy?: [string, string][]; // [challenger, opponent] in an active battle
  creators?: string[];
  members?: Record<string, string[]>; // agencyId -> creator ids
  memberOf?: Record<string, string>; // creator -> agency
  owners?: Record<string, string>; // agencyId -> owner
  // host -> session id. Defaults to "everyone online is live".
  live?: Record<string, string>;
  pending?: any;
  names?: Record<string, string>;
}

function build(w: World = {}) {
  const online = new Set(w.online ?? []);
  const live = w.live ?? Object.fromEntries([...online].map((id) => [id, `s-${id}`]));
  const follows = w.follows ?? [];
  const names = w.names ?? {};
  const prisma: any = {
    follow: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.followerId && typeof where.followerId === 'string') return follows.filter(([a]) => a === where.followerId).map(([, b]) => ({ followingId: b }));
        const ids: string[] = where.followerId?.in ?? [];
        return follows.filter(([a, b]) => ids.includes(a) && b === where.followingId).map(([a]) => ({ followerId: a }));
      }),
    },
    block: { findMany: jest.fn(async () => (w.blocks ?? []).map(([a, b]) => ({ blockerId: a, blockedId: b }))), findFirst: jest.fn().mockResolvedValue(null) },
    pKBattle: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.status === 'CHALLENGED') return [];
        return (w.busy ?? []).map(([a, b]) => ({ challengerId: a, opponentId: b }));
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.status === 'CHALLENGED') return w.pending ?? null;
        const users = [where.OR?.[0]?.challengerId, where.OR?.[1]?.opponentId];
        return (w.busy ?? []).some(([a, b]) => users.includes(a) || users.includes(b)) ? { id: 'busy' } : null;
      }),
      create: jest.fn(async ({ data }: any) => ({ id: 'b1', createdAt: new Date(), ...data })),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({ id: where.id })),
      update: jest.fn(async ({ data }: any) => data),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    userRole: { findMany: jest.fn(async ({ where }: any) => (w.creators ?? []).filter((id) => where.userId.in.includes(id)).map((userId) => ({ userId }))) },
    agencyMembership: {
      findFirst: jest.fn(async ({ where }: any) => (w.memberOf?.[where.creatorId] ? { agencyId: w.memberOf[where.creatorId] } : null)),
      findMany: jest.fn(async ({ where }: any) => (w.members?.[where.agencyId] ?? []).map((creatorId) => ({ creatorId }))),
    },
    agency: {
      findFirst: jest.fn(async ({ where }: any) => {
        const id = Object.keys(w.owners ?? {}).find((a) => w.owners![a] === where.ownerId);
        return id ? { id } : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => ({ ownerId: w.owners?.[where.id] ?? null })),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id, displayName: names[id] ?? id, avatarUrl: null }))),
      findUnique: jest.fn(async () => ({ displayName: 'Challenger', avatarUrl: 'https://x/c.jpg' })),
    },
    liveSession: {
      findMany: jest.fn(async ({ where }: any) => Object.entries(live).filter(([h]) => where.hostId.in.includes(h)).map(([hostId, id]) => ({ id, hostId, title: `${hostId} live` }))),
      findFirst: jest.fn(async ({ where }: any) => (live[where.hostId] ? { id: live[where.hostId], providerChannel: `c-${where.hostId}`, title: 'live' } : null)),
    },
    giftTransaction: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  const realtime: any = {
    onlineUserIds: jest.fn(async () => new Set(online)),
    isUserOnline: jest.fn(async (id: string) => online.has(id)),
    emitToUser: jest.fn(),
    broadcastPkEvent: jest.fn(),
  };
  const notifications: any = { notify: jest.fn(), notifyOnce: jest.fn() };
  return { svc: new PkService(prisma, {} as any, realtime, notifications), prisma, realtime, notifications };
}

const ids = (r: any) => r.candidates.map((c: any) => c.userId).sort();

describe('PkService.candidates — only people who are live right now', () => {
  it('friends: mutual follows who are live', async () => {
    const { svc } = build({ online: ['me', 'a', 'b', 'c'], follows: [['me', 'a'], ['a', 'me'], ['me', 'b'], ['me', 'c'], ['c', 'me'], ['me', 'off'], ['off', 'me']] });
    // b does not follow back; "off" is a mutual friend but not online
    expect(ids(await svc.candidates('me', 'friends'))).toEqual(['a', 'c']);
  });

  it('agency: the other creators in your agency and its owner — never yourself', async () => {
    const { svc } = build({ online: ['me', 'm1', 'm2', 'owner'], memberOf: { me: 'ag' }, members: { ag: ['me', 'm1', 'm2', 'm3'] }, owners: { ag: 'owner' } });
    expect(ids(await svc.candidates('me', 'agency'))).toEqual(['m1', 'm2', 'owner']);
  });

  it('random: live creators only', async () => {
    const { svc } = build({ online: ['me', 'c1', 'c2', 'fan'], creators: ['c1', 'c2', 'off'] });
    expect(ids(await svc.candidates('me', 'random'))).toEqual(['c1', 'c2']);
  });

  it('leaves out anyone you blocked or who blocked you, and anyone already in a battle', async () => {
    const { svc } = build({ online: ['me', 'a', 'b', 'c', 'd'], creators: ['a', 'b', 'c', 'd'], blocks: [['me', 'a'], ['b', 'me']], busy: [['c', 'zzz']] });
    expect(ids(await svc.candidates('me', 'random'))).toEqual(['d']);
  });

  it('someone online but not broadcasting is not a candidate', async () => {
    const { svc } = build({ online: ['me', 'a', 'b'], follows: [['me', 'a'], ['a', 'me'], ['me', 'b'], ['b', 'me']], live: { me: 's-me', b: 's-b' } });
    expect(ids(await svc.candidates('me', 'friends'))).toEqual(['b']);
  });
});

describe('PkService.challenge', () => {
  it('refuses someone who is not live, or already in a battle', async () => {
    await expect(build({ online: ['me'] }).svc.challenge('me', 'them')).rejects.toThrow("They aren't live");
    await expect(build({ online: ['me', 'them'], busy: [['them', 'x']] }).svc.challenge('me', 'them')).rejects.toThrow(/in a PK battle/);
  });

  it("sends the challenge to the inbox AND instantly to their screen, with the challenger's name and photo", async () => {
    const { svc, notifications, realtime, prisma } = build({ online: ['me', 'them'] });
    const battle = await svc.challenge('me', 'them');
    expect(prisma.pKBattle.create).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith('them', 'PK_CHALLENGE', expect.objectContaining({ battleId: 'b1' }));
    expect(realtime.emitToUser).toHaveBeenCalledWith('them', 'pk:challenge', { battleId: 'b1', challengerId: 'me', challengerDisplayName: 'Challenger', challengerAvatarUrl: 'https://x/c.jpg' });
    expect(battle).toMatchObject({ challengerId: 'me', opponentId: 'them' });
  });

  it('tapping Challenge twice returns the same pending challenge instead of sending another', async () => {
    const { svc, prisma, notifications } = build({ online: ['me', 'them'], pending: { id: 'existing', challengerId: 'me', opponentId: 'them', createdAt: new Date() } });
    expect(await svc.challenge('me', 'them')).toMatchObject({ id: 'existing' });
    expect(prisma.pKBattle.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('an expired pending challenge does not block a fresh one', async () => {
    const old = new Date(Date.now() - CHALLENGE_TTL_MS - 1);
    const { svc, prisma } = build({ online: ['me', 'them'], pending: { id: 'old', challengerId: 'me', opponentId: 'them', createdAt: old } });
    await svc.challenge('me', 'them');
    expect(prisma.pKBattle.create).toHaveBeenCalled();
  });

  it('cannot challenge yourself', async () => {
    await expect(build({ online: ['me'] }).svc.challenge('me', 'me')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PkService answering, cancelling and expiry', () => {
  it('only the challenged person can decline, and the challenger is told', async () => {
    const { svc, prisma, realtime } = build();
    prisma.pKBattle.findUnique.mockResolvedValue({ id: 'b1', challengerId: 'me', opponentId: 'them', status: 'CHALLENGED' });
    await expect(svc.decline('b1', 'someone-else')).rejects.toBeInstanceOf(ForbiddenException);
    await svc.decline('b1', 'them');
    expect(prisma.pKBattle.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { status: 'CANCELLED' } });
    expect(realtime.emitToUser).toHaveBeenCalledWith('me', 'pk:challenge_closed', expect.objectContaining({ battleId: 'b1', reason: 'DECLINED' }));
  });

  it('only the challenger can cancel a waiting invitation', async () => {
    const { svc, prisma, realtime } = build();
    prisma.pKBattle.findUnique.mockResolvedValue({ id: 'b1', challengerId: 'me', opponentId: 'them', status: 'CHALLENGED' });
    await expect(svc.cancel('b1', 'them')).rejects.toBeInstanceOf(ForbiddenException);
    await svc.cancel('b1', 'me');
    expect(realtime.emitToUser).toHaveBeenCalledWith('them', 'pk:challenge_closed', expect.objectContaining({ reason: 'CANCELLED' }));
  });

  it('accepting an expired invitation fails and tells both sides it expired', async () => {
    const { svc, prisma, realtime } = build({ online: ['me', 'them'] });
    prisma.pKBattle.findUnique.mockResolvedValue({ id: 'b1', challengerId: 'me', opponentId: 'them', status: 'CHALLENGED', createdAt: new Date(Date.now() - CHALLENGE_TTL_MS - 1) });
    await expect(svc.accept('b1', 'them')).rejects.toThrow(/expired/);
    expect(realtime.emitToUser).toHaveBeenCalledWith('me', 'pk:challenge_closed', expect.objectContaining({ reason: 'EXPIRED' }));
  });

  it('the reaper expires invitations older than the TTL', async () => {
    const { svc, prisma, realtime } = build();
    prisma.pKBattle.findMany.mockResolvedValueOnce([{ id: 'old', challengerId: 'a', opponentId: 'b' }]);
    expect(await svc.expireStaleChallenges(new Date())).toEqual(['old']);
    expect(realtime.emitToUser).toHaveBeenCalledWith('b', 'pk:challenge_closed', expect.objectContaining({ reason: 'EXPIRED' }));
  });
});

describe('PkService ending early', () => {
  it('a host who quits an ACTIVE PK loses it', async () => {
    const { svc, prisma, realtime } = build();
    prisma.pKBattle.findUnique.mockResolvedValue({ id: 'b1', challengerId: 'A', opponentId: 'B', status: 'ACTIVE' });
    prisma.pKBattle.findUniqueOrThrow.mockResolvedValue({ id: 'b1', challengerId: 'A', opponentId: 'B', status: 'SETTLED', winnerId: 'B', scoreChallenger: 0n, scoreOpponent: 0n, startedAt: null, endsAt: null, settledAt: new Date() });
    await svc.forfeit('b1', 'A');
    expect(prisma.pKBattle.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'SETTLED', winnerId: 'B' });
    expect(realtime.broadcastPkEvent).toHaveBeenCalledWith('b1', ['A', 'B'], expect.any(Array), 'pk:settled', expect.any(Object));
  });

  it('quitting during the countdown just calls it off, and outsiders cannot quit it', async () => {
    const { svc, prisma } = build();
    prisma.pKBattle.findUnique.mockResolvedValue({ id: 'b1', challengerId: 'A', opponentId: 'B', status: 'COUNTDOWN' });
    prisma.pKBattle.findUniqueOrThrow.mockResolvedValue({ id: 'b1', challengerId: 'A', opponentId: 'B', status: 'CANCELLED', scoreChallenger: 0n, scoreOpponent: 0n });
    await expect(svc.forfeit('b1', 'X')).rejects.toBeInstanceOf(ForbiddenException);
    await svc.forfeit('b1', 'B');
    expect(prisma.pKBattle.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CANCELLED' });
  });

  it('a PK whose host stopped broadcasting is ended, and the host who left loses', async () => {
    const { svc, prisma } = build({ live: { B: 's-B' } });
    prisma.pKBattle.findMany.mockResolvedValueOnce([{ id: 'b1', challengerId: 'A', opponentId: 'B', status: 'ACTIVE' }]);
    prisma.pKBattle.findUniqueOrThrow.mockResolvedValue({ id: 'b1', challengerId: 'A', opponentId: 'B', status: 'SETTLED', winnerId: 'B', scoreChallenger: 0n, scoreOpponent: 0n });
    expect(await svc.endBattlesWithoutHosts()).toEqual(['b1']);
    expect(prisma.pKBattle.updateMany.mock.calls[0][0].data).toMatchObject({ winnerId: 'B' });
  });
});

describe('PkService.findActiveForHost', () => {
  it('reports the phase, both hosts and the result window end', async () => {
    const { svc, prisma } = build({ live: { A: 's-A', B: 's-B' }, names: { A: 'Ada', B: 'Bo' } });
    const settledAt = new Date();
    prisma.pKBattle.findFirst.mockResolvedValue({ id: 'b1', challengerId: 'A', opponentId: 'B', status: 'SETTLED', settledAt, winnerId: 'A' });
    const out: any = await svc.findActiveForHost('A');
    expect(out.phase).toBe('RESULT');
    expect(out.opponentDisplayName).toBe('Bo');
    expect(out.opponentSession).toMatchObject({ id: 's-B' });
    expect(out.resultEndsAt.getTime()).toBe(settledAt.getTime() + RESULT_MS);
  });

  it('returns null when there is nothing to show', async () => {
    const { svc, prisma } = build();
    prisma.pKBattle.findFirst.mockResolvedValue(null);
    expect(await svc.findActiveForHost('A')).toBeNull();
  });
});

describe('PkService.randomChallenge', () => {
  it('challenges one live creator, or says nobody is available', async () => {
    const { svc, prisma } = build({ online: ['me', 'c1'], creators: ['c1'], names: { c1: 'Cee' } });
    const out = await svc.randomChallenge('me');
    expect(out.opponent).toMatchObject({ userId: 'c1', displayName: 'Cee' });
    expect(prisma.pKBattle.create.mock.calls[0][0].data).toMatchObject({ challengerId: 'me', opponentId: 'c1' });
    await expect(build({ online: ['me'] }).svc.randomChallenge('me')).rejects.toBeInstanceOf(NotFoundException);
  });
});
