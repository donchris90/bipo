import { TeamsService } from './teams.service';
import { Prisma } from '@prisma/client';

const TEAM_LEVELS = [
  { level: 1, name: 'New Team', xpRequired: 0, active: true },
  { level: 2, name: 'Forming Up', xpRequired: 100, active: true },
];

function build() {
  const teams = new Map<string, any>();
  const membersByUser = new Map<string, any>(); // userId -> membership
  let idCounter = 0;

  const prisma: any = {
    team: {
      findUnique: async ({ where }: any) => teams.get(where.id) ?? null,
      create: async ({ data }: any) => {
        if ([...teams.values()].some((t) => t.name === data.name)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        const t = { id: `team-${++idCounter}`, teamXp: 0, teamLevel: 1, createdAt: new Date(), ...data };
        teams.set(t.id, t);
        return t;
      },
      update: async ({ where, data }: any) => {
        const t = teams.get(where.id);
        if (data.teamXp?.increment) t.teamXp += data.teamXp.increment;
        for (const k of Object.keys(data)) if (k !== 'teamXp') t[k] = data[k];
        return { ...t }; // a fresh copy per call, like real Prisma — never the live mutable row
      },
      delete: async ({ where }: any) => { teams.delete(where.id); },
      count: async ({ where }: any) => [...teams.values()].filter((t) => where?.teamXp?.gt === undefined || t.teamXp > where.teamXp.gt).length,
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = [...teams.values()];
        if (where?.countryCode) rows = rows.filter((t) => t.countryCode === where.countryCode);
        rows.sort((a, b) => (orderBy.teamXp === 'desc' ? b.teamXp - a.teamXp : a.teamXp - b.teamXp));
        return take ? rows.slice(0, take) : rows;
      },
    },
    teamMember: {
      findUnique: async ({ where }: any) => membersByUser.get(where.userId) ?? null,
      findMany: async ({ where, orderBy }: any) => {
        let rows = [...membersByUser.values()].filter((m) => m.teamId === where.teamId && (!where.userId || (where.userId.not !== undefined ? m.userId !== where.userId.not : m.userId === where.userId)));
        if (orderBy?.joinedAt === 'asc') rows.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
        if (orderBy?.xp === 'desc') rows.sort((a, b) => b.xp - a.xp);
        return rows;
      },
      count: async ({ where }: any) => [...membersByUser.values()].filter((m) => m.teamId === where.teamId).length,
      create: async ({ data }: any) => {
        if (membersByUser.has(data.userId)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        const m = { id: `member-${++idCounter}`, xp: 0, joinedAt: new Date(), ...data };
        membersByUser.set(data.userId, m);
        return m;
      },
      update: async ({ where, data }: any) => {
        const m = membersByUser.get(where.userId);
        if (data.xp?.increment) m.xp += data.xp.increment;
        for (const k of Object.keys(data)) if (k !== 'xp') m[k] = data[k];
        return m;
      },
      delete: async ({ where }: any) => { membersByUser.delete(where.userId); },
    },
    teamLevel: {
      findMany: async () => TEAM_LEVELS,
      upsert: async ({ where, update, create }: any) => ({ level: where.level, ...create, ...update }),
    },
    user: { findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id, displayName: id, avatarUrl: null })) },
    userRole: { findMany: async ({ where }: any) => (where.role === 'CREATOR' ? where.userId.in.filter((id: string) => id.startsWith('creator')).map((id: string) => ({ userId: id })) : []) },
    $transaction: async (fn: any) => fn(prisma),
  };

  const notifications: any = { notifyOnce: jest.fn().mockResolvedValue(undefined) };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };

  return { svc: new TeamsService(prisma, notifications, audit), teams, membersByUser, notifications };
}

describe('TeamsService.createTeam', () => {
  it('creates a team and makes the creator its LEADER', async () => {
    const { svc, membersByUser } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    expect(team.leaderId).toBe('u1');
    expect(membersByUser.get('u1')).toMatchObject({ teamId: team.id, role: 'LEADER' });
  });

  it('rejects creating a second team while already on one', async () => {
    const { svc } = build();
    await svc.createTeam('u1', { name: 'Team A', countryCode: 'NG' });
    await expect(svc.createTeam('u1', { name: 'Team B', countryCode: 'NG' })).rejects.toThrow('already belong');
  });

  it('rejects a duplicate team name', async () => {
    const { svc } = build();
    await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await expect(svc.createTeam('u2', { name: 'Team Lagos', countryCode: 'NG' })).rejects.toThrow('already taken');
  });

  it('rejects an empty name and an invalid theme color', async () => {
    const { svc } = build();
    await expect(svc.createTeam('u1', { name: '  ', countryCode: 'NG' })).rejects.toThrow('required');
    await expect(svc.createTeam('u1', { name: 'Team X', countryCode: 'NG', themeColor: 'blue' })).rejects.toThrow('hex');
  });
});

describe('TeamsService.joinTeam', () => {
  it('lets a second user join an existing team as a MEMBER', async () => {
    const { svc, membersByUser } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.joinTeam('u2', team.id);
    expect(membersByUser.get('u2')).toMatchObject({ teamId: team.id, role: 'MEMBER' });
  });

  it('rejects joining a team you are already on another team for', async () => {
    const { svc } = build();
    const teamA = await svc.createTeam('u1', { name: 'Team A', countryCode: 'NG' });
    await svc.createTeam('u2', { name: 'Team B', countryCode: 'NG' });
    await expect(svc.joinTeam('u2', teamA.id)).rejects.toThrow('already belong');
  });

  it('rejects joining a team that does not exist', async () => {
    const { svc } = build();
    await expect(svc.joinTeam('u1', 'no-such-team')).rejects.toThrow('not found');
  });
});

describe('TeamsService.leaveTeam', () => {
  it('lets a plain member leave cleanly', async () => {
    const { svc, membersByUser } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.joinTeam('u2', team.id);
    const result = await svc.leaveTeam('u2');
    expect(result).toEqual({ disbanded: false, newLeaderId: null });
    expect(membersByUser.has('u2')).toBe(false);
  });

  it('promotes the earliest-joined remaining member when the leader leaves', async () => {
    const { svc, membersByUser, teams } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.joinTeam('u2', team.id);
    await svc.joinTeam('u3', team.id);
    const result = await svc.leaveTeam('u1');
    expect(result.disbanded).toBe(false);
    expect(result.newLeaderId).toBe('u2'); // earliest-joined of the two remaining
    expect(membersByUser.get('u2').role).toBe('LEADER');
    expect(teams.get(team.id).leaderId).toBe('u2');
    expect(membersByUser.has('u1')).toBe(false);
  });

  it('disbands the team if the leader was the only member', async () => {
    const { svc, teams } = build();
    const team = await svc.createTeam('u1', { name: 'Solo Team', countryCode: 'NG' });
    const result = await svc.leaveTeam('u1');
    expect(result.disbanded).toBe(true);
    expect(teams.has(team.id)).toBe(false);
  });

  it('rejects leaving when not on a team', async () => {
    const { svc } = build();
    await expect(svc.leaveTeam('ghost')).rejects.toThrow('not on a team');
  });
});

describe('TeamsService.setModerator', () => {
  it('lets the leader promote a member to moderator', async () => {
    const { svc, membersByUser } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.joinTeam('u2', team.id);
    await svc.setModerator('u1', 'u2', true);
    expect(membersByUser.get('u2').role).toBe('MODERATOR');
    await svc.setModerator('u1', 'u2', false);
    expect(membersByUser.get('u2').role).toBe('MEMBER');
  });

  it('refuses a non-leader trying to promote someone', async () => {
    const { svc } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.joinTeam('u2', team.id);
    await svc.joinTeam('u3', team.id);
    await expect(svc.setModerator('u2', 'u3', true)).rejects.toThrow('Only the team leader');
  });

  it("refuses changing the leader's own role this way", async () => {
    const { svc } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.joinTeam('u2', team.id);
    await expect(svc.setModerator('u1', 'u1', true)).rejects.toThrow("leader's role");
  });

  it('refuses targeting someone on a different team', async () => {
    const { svc } = build();
    await svc.createTeam('u1', { name: 'Team A', countryCode: 'NG' });
    await svc.createTeam('u2', { name: 'Team B', countryCode: 'NG' });
    await expect(svc.setModerator('u1', 'u2', true)).rejects.toThrow('not on your team');
  });
});

describe('TeamsService.contributeXp', () => {
  it('is a no-op for someone not on a team', async () => {
    const { svc, teams } = build();
    await svc.contributeXp('ghost', 500);
    expect(teams.size).toBe(0);
  });

  it("adds the FULL amount to both the member's and the team's XP (1:1, not a fraction)", async () => {
    const { svc, membersByUser, teams } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.contributeXp('u1', 80);
    expect(membersByUser.get('u1').xp).toBe(80);
    expect(teams.get(team.id).teamXp).toBe(80);
  });

  it('levels the team up and notifies the leader exactly once', async () => {
    const { svc, teams, notifications } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.contributeXp('u1', 60);
    expect(teams.get(team.id).teamLevel).toBe(1);
    await svc.contributeXp('u1', 60); // total 120, crosses the 100 threshold
    expect(teams.get(team.id).teamLevel).toBe(2);
    expect(notifications.notifyOnce).toHaveBeenCalledTimes(1);
    expect(notifications.notifyOnce).toHaveBeenCalledWith('u1', 'TEAM_LEVEL_UP', expect.any(String), expect.objectContaining({ level: 2 }));
  });

  it('ignores zero, negative, and NaN amounts', async () => {
    const { svc, membersByUser } = build();
    await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.contributeXp('u1', 0);
    await svc.contributeXp('u1', -5);
    await svc.contributeXp('u1', NaN);
    expect(membersByUser.get('u1').xp).toBe(0);
  });

  it('never throws even if the database is unreachable', async () => {
    const prisma: any = { teamMember: { findUnique: async () => { throw new Error('db down'); } } };
    const svc = new TeamsService(prisma, { notifyOnce: jest.fn() } as any, { record: jest.fn() } as any);
    await expect(svc.contributeXp('u1', 50)).resolves.toBeUndefined();
  });
});

describe('TeamsService reads', () => {
  it('teamSnapshot reflects rank, member count, and the viewer\'s own membership', async () => {
    const { svc } = build();
    const teamA = await svc.createTeam('u1', { name: 'Team A', countryCode: 'NG' });
    const teamB = await svc.createTeam('u2', { name: 'Team B', countryCode: 'NG' });
    await svc.joinTeam('u3', teamA.id);
    await svc.contributeXp('u1', 500); // Team A now ahead of Team B

    const snapA = await svc.teamSnapshot(teamA.id, 'u3');
    expect(snapA).toMatchObject({ memberCount: 2, rank: 1 });
    expect(snapA!.viewer).toMatchObject({ onThisTeam: true, role: 'MEMBER' });

    const snapB = await svc.teamSnapshot(teamB.id, 'u3');
    expect(snapB).toMatchObject({ memberCount: 1, rank: 2 });
    expect(snapB!.viewer).toMatchObject({ onThisTeam: false, role: null });
  });

  it('teamSnapshot returns null for an unknown team', async () => {
    const { svc } = build();
    expect(await svc.teamSnapshot('no-such-team', 'u1')).toBeNull();
  });

  it("myTeam resolves the caller's own team, or null", async () => {
    const { svc } = build();
    const team = await svc.createTeam('u1', { name: 'Team Lagos', countryCode: 'NG' });
    expect((await svc.myTeam('u1'))!.id).toBe(team.id);
    expect(await svc.myTeam('nobody')).toBeNull();
  });

  it('listRoster splits creators from supporters', async () => {
    const { svc } = build();
    const team = await svc.createTeam('creator1', { name: 'Team Lagos', countryCode: 'NG' });
    await svc.joinTeam('supporter1', team.id);
    const roster = await svc.listRoster(team.id);
    expect(roster).toMatchObject({ creatorCount: 1, supporterCount: 1 });
  });

  it('listTopTeams orders by XP descending and respects the country filter', async () => {
    const { svc } = build();
    const ng1 = await svc.createTeam('u1', { name: 'NG Team 1', countryCode: 'NG' });
    await svc.createTeam('u2', { name: 'NG Team 2', countryCode: 'NG' });
    await svc.createTeam('u3', { name: 'US Team', countryCode: 'US' });
    await svc.contributeXp('u1', 999);

    const top = await svc.listTopTeams();
    expect(top[0].id).toBe(ng1.id);
    expect(top[0].rank).toBe(1);

    const ngOnly = await svc.listTopTeams(20, 'NG');
    expect(ngOnly.every((t) => t.countryCode === 'NG')).toBe(true);
    expect(ngOnly).toHaveLength(2);
  });
});

describe('TeamsService admin level editing', () => {
  it('lists the configured curve', async () => {
    const { svc } = build();
    expect(await svc.listTeamLevels()).toHaveLength(2);
  });

  it('rejects a negative xpRequired', async () => {
    const { svc } = build();
    await expect(svc.updateTeamLevel(3, { name: 'X', xpRequired: -1 }, 'admin1', ['SUPER_ADMIN'] as any)).rejects.toThrow('non-negative');
  });

  it('applies a valid update', async () => {
    const { svc } = build();
    const updated = await svc.updateTeamLevel(3, { name: 'Rising Team', xpRequired: 500 }, 'admin1', ['SUPER_ADMIN'] as any);
    expect(updated).toMatchObject({ name: 'Rising Team', xpRequired: 500 });
  });
});
