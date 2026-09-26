import { RoomCommunityService } from './room-community.service';

const ROOM_LEVELS = [
  { level: 1, name: 'New Room', xpRequired: 0, active: true },
  { level: 2, name: 'Warming Up', xpRequired: 20, active: true },
];
const MEMBER_LEVELS = [
  { level: 1, name: 'Visitor', xpRequired: 0, active: true },
  { level: 2, name: 'Familiar Face', xpRequired: 15, active: true },
];
const ACHIEVEMENTS = [
  { key: 'FIRST_VISIT', label: 'First Visit', emoji: '👋', description: 'Visited for the first time', active: true },
  { key: 'WEEK_STREAK', label: 'Week Streak', emoji: '🔥', description: '7 days in a row', active: true },
  { key: 'BECAME_REGULAR', label: 'Regular', emoji: '⭐', description: '5 distinct visits', active: true },
  { key: 'TOP_SUPPORTER', label: 'Top Supporter', emoji: '👑', description: 'Biggest gifter in the room', active: true },
];

function build(hostId = 'host1') {
  const rooms = new Map<string, any>([[hostId, { id: 'room1', hostId, title: 'Test Room', description: null, themeColor: null, category: null, roomXp: 0, roomLevel: 1, streak: 0, lastLiveAt: null }]]);
  const roomsById = new Map<string, any>([['room1', rooms.get(hostId)]]);
  const members = new Map<string, any>(); // key: roomId|userId
  const memberAchievements: any[] = [];
  let idCounter = 0;

  const prisma: any = {
    room: {
      findUnique: async ({ where }: any) => (where.hostId ? rooms.get(where.hostId) ?? null : roomsById.get(where.id) ?? null),
      create: async ({ data }: any) => { const r = { id: `room-${++idCounter}`, roomXp: 0, roomLevel: 1, streak: 0, lastLiveAt: null, description: null, ...data }; rooms.set(data.hostId, r); roomsById.set(r.id, r); return r; },
      update: async ({ where, data }: any) => {
        const r = where.hostId ? rooms.get(where.hostId) : roomsById.get(where.id);
        if (data.roomXp?.increment) r.roomXp += data.roomXp.increment;
        for (const k of Object.keys(data)) if (k !== 'roomXp') r[k] = data[k];
        return r;
      },
    },
    roomLevel: { findMany: async () => ROOM_LEVELS },
    roomMemberLevel: { findMany: async () => MEMBER_LEVELS, upsert: async ({ where, update, create }: any) => ({ level: where.level, ...create, ...update }) },
    roomMember: {
      findUnique: async ({ where }: any) => members.get(`${where.roomId_userId.roomId}|${where.roomId_userId.userId}`) ?? null,
      findFirst: async ({ where, orderBy }: any) => {
        const rows = [...members.values()].filter((m) => m.roomId === where.roomId);
        rows.sort((a, b) => (orderBy.xp === 'desc' ? b.xp - a.xp : a.xp - b.xp));
        return rows[0] ?? null;
      },
      count: async ({ where }: any) => [...members.values()].filter((m) => m.roomId === where.roomId && (where.isRegular === undefined || m.isRegular === where.isRegular)).length,
      upsert: async ({ where, update, create }: any) => {
        const key = `${where.roomId_userId.roomId}|${where.roomId_userId.userId}`;
        const existing = members.get(key);
        if (existing) {
          if (update.xp?.increment) existing.xp += update.xp.increment;
          for (const k of Object.keys(update)) if (k !== 'xp') existing[k] = update[k];
          return existing;
        }
        const m = { id: `member-${++idCounter}`, level: 1, ...create };
        members.set(key, m);
        return m;
      },
      update: async ({ where, data }: any) => {
        const m = [...members.values()].find((x) => x.id === where.id);
        Object.assign(m, data);
        return m;
      },
    },
    roomAchievement: {
      findUnique: async ({ where }: any) => ACHIEVEMENTS.find((a) => a.key === where.key) ?? null,
      findMany: async () => ACHIEVEMENTS,
    },
    roomMemberAchievement: {
      create: async ({ data }: any) => {
        if (memberAchievements.some((a) => a.roomId === data.roomId && a.userId === data.userId && a.achievementKey === data.achievementKey)) {
          const e: any = new Error('dup'); e.code = 'P2002'; throw e;
        }
        const row = { ...data, earnedAt: new Date() };
        memberAchievements.push(row);
        return row;
      },
      findMany: async ({ where }: any) => memberAchievements.filter((a) => a.roomId === where.roomId && a.userId === where.userId),
    },
    user: { findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id, displayName: id, avatarUrl: null })) },
    partyRoom: { findUnique: async () => ({ roomId: 'room1' }) },
  };

  const notifications: any = { notifyOnce: jest.fn().mockResolvedValue(undefined) };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  const hostLevels: any = { awardRule: jest.fn().mockResolvedValue(undefined) };

  return { svc: new RoomCommunityService(prisma, notifications, audit, hostLevels), members, notifications, hostLevels };
}

describe('RoomCommunityService.roomLevelSummary', () => {
  it('returns null without a roomId, and null for an unknown room', async () => {
    const { svc } = build();
    expect(await svc.roomLevelSummary(null)).toBeNull();
    expect(await svc.roomLevelSummary('does-not-exist')).toBeNull();
  });

  it('returns the correct shape for a fresh room', async () => {
    const { svc } = build();
    const summary = await svc.roomLevelSummary('room1');
    expect(summary).toMatchObject({ level: 1, name: 'New Room', streak: 0, xp: 0 });
  });
});

describe('RoomCommunityService.recordVisit', () => {
  it('awards member XP and starts the streak on a first visit', async () => {
    const { svc, members } = build();
    await svc.recordVisit('room1', 'viewer1');
    const m = members.get('room1|viewer1');
    expect(m).toMatchObject({ xp: 10, visitCount: 1, visitStreak: 1 });
  });

  it("also grows the room's own XP from the visit", async () => {
    const { svc } = build();
    await svc.recordVisit('room1', 'viewer1');
    const summary = await svc.roomLevelSummary('room1');
    expect(summary!.xp).toBe(5);
  });

  it('is a no-op for a second visit the same day', async () => {
    const { svc, members } = build();
    await svc.recordVisit('room1', 'viewer1');
    await svc.recordVisit('room1', 'viewer1');
    expect(members.get('room1|viewer1').xp).toBe(10);
  });

  it('makes a member a regular after 5 distinct-day visits', async () => {
    const { svc, members } = build();
    const base = new Date('2026-09-01T12:00:00Z');
    for (let day = 0; day < 5; day++) {
      const m = members.get('room1|viewer1');
      if (m) m.lastVisitAt = new Date(base.getTime() + (day - 1) * 24 * 3600_000); // force "yesterday" each time
      await svc.recordVisit('room1', 'viewer1');
    }
    expect(members.get('room1|viewer1')).toMatchObject({ visitCount: 5, isRegular: true });
  });
});

describe('RoomCommunityService.awardGiftXp', () => {
  it("adds the full coin amount to the member's XP and 1/10th to the room's", async () => {
    const { svc, members } = build();
    await svc.awardGiftXp('party-session-1', 'viewer1', 500);
    expect(members.get('room1|viewer1').xp).toBe(500);
    const summary = await svc.roomLevelSummary('room1');
    expect(summary!.xp).toBe(50);
  });
});

describe('RoomCommunityService.setIdentity', () => {
  it('rejects a whitespace-only title', async () => {
    const { svc } = build();
    await expect(svc.setIdentity('host1', { title: '   ' })).rejects.toThrow('empty');
  });

  it('rejects an invalid theme color', async () => {
    const { svc } = build();
    await expect(svc.setIdentity('host1', { themeColor: 'not-a-color' })).rejects.toThrow('hex');
  });

  it('applies a valid update', async () => {
    const { svc } = build();
    const updated = await svc.setIdentity('host1', { title: 'New Title', themeColor: '#FF00AA', description: 'A place to hang out' });
    expect(updated).toMatchObject({ title: 'New Title', themeColor: '#FF00AA', description: 'A place to hang out' });
  });
});

describe('RoomCommunityService RoomMemberLevel admin editing', () => {
  it('lists the configured curve', async () => {
    const { svc } = build();
    expect(await svc.listRoomMemberLevels()).toHaveLength(2);
  });

  it('rejects a negative xpRequired', async () => {
    const { svc } = build();
    await expect(svc.updateRoomMemberLevel(3, { name: 'X', xpRequired: -1 }, 'admin1', ['SUPER_ADMIN'] as any)).rejects.toThrow('non-negative');
  });

  it('applies a valid update', async () => {
    const { svc } = build();
    const updated = await svc.updateRoomMemberLevel(3, { name: 'Superfan', xpRequired: 100 }, 'admin1', ['SUPER_ADMIN'] as any);
    expect(updated).toMatchObject({ name: 'Superfan', xpRequired: 100 });
  });
});

describe('RoomCommunityService.listAchievementsForHost', () => {
  it('returns the full catalog with correct earned/locked state', async () => {
    const { svc } = build();
    await svc.recordVisit('room1', 'viewer1'); // earns FIRST_VISIT
    const list = await svc.listAchievementsForHost('host1', 'viewer1');
    expect(list).toHaveLength(4);
    expect(list.find((a) => a.key === 'FIRST_VISIT')).toMatchObject({ earned: true });
    expect(list.find((a) => a.key === 'WEEK_STREAK')).toMatchObject({ earned: false });
  });

  it('returns an empty list for an unknown host rather than throwing', async () => {
    const { svc } = build();
    await expect(svc.listAchievementsForHost('no-such-host', 'viewer1')).resolves.toEqual([]);
  });
});
