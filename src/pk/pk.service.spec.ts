import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PkService } from './pk.service';

interface World {
  online?: string[];
  follows?: [string, string][]; // [follower, following]
  blocks?: [string, string][];
  busy?: [string, string][]; // [challenger, opponent] in an active battle
  creators?: string[];
  members?: Record<string, string[]>; // agencyId -> creator ids
  memberOf?: Record<string, string>; // creator -> agency
  owners?: Record<string, string>; // agencyId -> owner
  live?: Record<string, string>; // host -> session id
  pending?: any;
  names?: Record<string, string>;
}

function build(w: World = {}) {
  const online = new Set(w.online ?? []);
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
      findMany: jest.fn(async () => (w.busy ?? []).map(([a, b]) => ({ challengerId: a, opponentId: b }))),
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.status === 'CHALLENGED') return w.pending ?? null;
        const users = [where.OR?.[0]?.challengerId, where.OR?.[1]?.opponentId];
        return (w.busy ?? []).some(([a, b]) => users.includes(a) || users.includes(b)) ? { id: 'busy' } : null;
      }),
      create: jest.fn(async ({ data }: any) => ({ id: 'b1', ...data })),
      findUnique: jest.fn(),
      update: jest.fn(async ({ data }: any) => data),
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
    liveSession: { findMany: jest.fn(async ({ where }: any) => Object.entries(w.live ?? {}).filter(([h]) => where.hostId.in.includes(h)).map(([hostId, id]) => ({ id, hostId, title: `${hostId} live` }))) },
  };
  const realtime: any = {
    onlineUserIds: jest.fn(async () => new Set(online)),
    isUserOnline: jest.fn(async (id: string) => online.has(id)),
    emitToUser: jest.fn(),
  };
  const notifications: any = { notify: jest.fn() };
  return { svc: new PkService(prisma, {} as any, realtime, notifications), prisma, realtime, notifications };
}

const ids = (r: any) => r.candidates.map((c: any) => c.userId).sort();

describe('PkService.candidates — only people who are online', () => {
  it('friends: mutual follows who are online', async () => {
    const { svc } = build({ online: ['me', 'a', 'b', 'c'], follows: [['me', 'a'], ['a', 'me'], ['me', 'b'], ['me', 'c'], ['c', 'me'], ['me', 'off'], ['off', 'me']] });
    // b does not follow back; "off" is a mutual friend but not online
    expect(ids(await svc.candidates('me', 'friends'))).toEqual(['a', 'c']);
  });

  it('agency: the other creators in your agency and its owner, online only — never yourself', async () => {
    const { svc } = build({ online: ['me', 'm1', 'm2', 'owner'], memberOf: { me: 'ag' }, members: { ag: ['me', 'm1', 'm2', 'm3'] }, owners: { ag: 'owner' } });
    expect(ids(await svc.candidates('me', 'agency'))).toEqual(['m1', 'm2', 'owner']); // m3 is offline
  });

  it('agency owners see their own creators; people with no agency see nobody', async () => {
    const owner = build({ online: ['own', 'm1'], members: { ag: ['m1'] }, owners: { ag: 'own' } });
    expect(ids(await owner.svc.candidates('own', 'agency'))).toEqual(['m1']);
    expect(ids(await build({ online: ['me', 'x'] }).svc.candidates('me', 'agency'))).toEqual([]);
  });

  it('random: online creators only', async () => {
    const { svc } = build({ online: ['me', 'c1', 'c2', 'fan'], creators: ['c1', 'c2', 'off'] });
    expect(ids(await svc.candidates('me', 'random'))).toEqual(['c1', 'c2']);
  });

  it('leaves out anyone you blocked or who blocked you, and anyone already in a battle', async () => {
    const { svc } = build({ online: ['me', 'a', 'b', 'c', 'd'], creators: ['a', 'b', 'c', 'd'], blocks: [['me', 'a'], ['b', 'me']], busy: [['c', 'zzz']] });
    expect(ids(await svc.candidates('me', 'random'))).toEqual(['d']);
  });

  it('puts people who are live right now first, with their session', async () => {
    const { svc } = build({ online: ['me', 'a', 'b'], follows: [['me', 'a'], ['a', 'me'], ['me', 'b'], ['b', 'me']], live: { b: 's-b' }, names: { a: 'Ada', b: 'Bo' } });
    const res = await svc.candidates('me', 'friends');
    expect(res.candidates.map((c) => c.userId)).toEqual(['b', 'a']);
    expect(res.candidates[0].live).toEqual({ sessionId: 's-b', title: 'b live' });
    expect(res.onlineCount).toBe(2);
  });
});

describe('PkService.challenge', () => {
  it('refuses someone who is offline, or already in a battle', async () => {
    await expect(build({ online: ['me'] }).svc.challenge('me', 'them')).rejects.toThrow("They aren't online");
    await expect(build({ online: ['me', 'them'], busy: [['them', 'x']] }).svc.challenge('me', 'them')).rejects.toThrow(/in a PK battle/);
  });

  it('sends the challenge to the inbox AND instantly to their screen, with the challenger\'s name and photo', async () => {
    const { svc, notifications, realtime, prisma } = build({ online: ['me', 'them'] });
    const battle = await svc.challenge('me', 'them');
    expect(prisma.pKBattle.create).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith('them', 'PK_CHALLENGE', expect.objectContaining({ battleId: 'b1' }));
    expect(realtime.emitToUser).toHaveBeenCalledWith('them', 'pk:challenge', { battleId: 'b1', challengerId: 'me', challengerDisplayName: 'Challenger', challengerAvatarUrl: 'https://x/c.jpg' });
    expect(battle).toMatchObject({ challengerId: 'me', opponentId: 'them' });
  });

  it('tapping Challenge twice returns the same pending challenge instead of sending another', async () => {
    const { svc, prisma, notifications } = build({ online: ['me', 'them'], pending: { id: 'existing', challengerId: 'me', opponentId: 'them' } });
    expect(await svc.challenge('me', 'them')).toMatchObject({ id: 'existing' });
    expect(prisma.pKBattle.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('cannot challenge yourself', async () => {
    await expect(build({ online: ['me'] }).svc.challenge('me', 'me')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PkService.randomChallenge and decline', () => {
  it('challenges one online creator, or says nobody is available', async () => {
    const { svc, prisma } = build({ online: ['me', 'c1'], creators: ['c1'], names: { c1: 'Cee' } });
    const out = await svc.randomChallenge('me');
    expect(out.opponent).toMatchObject({ userId: 'c1', displayName: 'Cee' });
    expect(prisma.pKBattle.create.mock.calls[0][0].data).toMatchObject({ challengerId: 'me', opponentId: 'c1' });
    await expect(build({ online: ['me'] }).svc.randomChallenge('me')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only the challenged person can decline, and only while it is waiting', async () => {
    const { svc, prisma } = build();
    prisma.pKBattle.findUnique.mockResolvedValue({ id: 'b1', opponentId: 'them', status: 'CHALLENGED' });
    await expect(svc.decline('b1', 'someone-else')).rejects.toBeInstanceOf(ForbiddenException);
    await svc.decline('b1', 'them');
    expect(prisma.pKBattle.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { status: 'CANCELLED' } });
    prisma.pKBattle.findUnique.mockResolvedValue({ id: 'b1', opponentId: 'them', status: 'ACTIVE' });
    await expect(svc.decline('b1', 'them')).rejects.toBeInstanceOf(BadRequestException);
  });
});
