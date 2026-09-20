import { BadRequestException } from '@nestjs/common';
import { AnnouncementsService, cleanAnnouncement, giftText, winText } from './announcements.service';

describe('announcement text', () => {
  it('never shows an id — a missing name becomes a neutral word', () => {
    expect(winText('Ada', 12500, 'Crash')).toBe('🏆 Ada just won 12,500 coins in Crash');
    expect(winText(null, 900, 'Dice')).toBe('🏆 A player just won 900 coins in Dice');
    expect(giftText('Bo', 'Rose', 'Ada', 10)).toContain('Bo sent Rose (10 coins) to Ada');
    expect(giftText(null, 'Rose', null, 10)).toBe('🎁 Someone sent Rose (10 coins) to a host');
  });
});

describe('cleanAnnouncement', () => {
  it('validates length, priority and dates', () => {
    expect(cleanAnnouncement({ text: '  Weekend PK tournament  ' })).toMatchObject({ text: 'Weekend PK tournament', priority: 0, active: true });
    expect(() => cleanAnnouncement({ text: 'hi' })).toThrow(BadRequestException);
    expect(() => cleanAnnouncement({ text: 'x'.repeat(201) })).toThrow(BadRequestException);
    expect(() => cleanAnnouncement({ text: 'ok text', priority: 1.5 })).toThrow(/priority/);
    expect(() => cleanAnnouncement({ text: 'ok text', startsAt: 'nope' })).toThrow(/startsAt/);
    expect(() => cleanAnnouncement({ text: 'ok text', startsAt: '2026-09-02', endsAt: '2026-09-01' })).toThrow(/endsAt/);
  });
});

function build(over: any = {}) {
  const prisma: any = {
    announcement: { findMany: jest.fn().mockResolvedValue(over.custom ?? []), create: jest.fn(async ({ data }: any) => ({ id: 'a1', ...data })), findUnique: jest.fn().mockResolvedValue(over.existing ?? null), update: jest.fn(async ({ data }: any) => ({ id: 'a1', ...data })), delete: jest.fn() },
    gameEntry: { findMany: jest.fn().mockResolvedValue(over.wins ?? []) },
    gameRound: { findMany: jest.fn().mockResolvedValue([{ id: 'r1', gameCode: 'CRASH' }]) },
    gameDefinition: { findMany: jest.fn().mockResolvedValue([{ code: 'CRASH', name: 'Crash' }]) },
    giftTransaction: { findMany: jest.fn().mockResolvedValue(over.gifts ?? []) },
    gift: { findUnique: jest.fn().mockResolvedValue({ name: 'Rose' }) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', displayName: 'Ada' }, { id: 'u2', displayName: 'Bo' }]) },
  };
  const audit: any = { record: jest.fn() };
  return { svc: new AnnouncementsService(prisma, audit), prisma, audit };
}

describe('AnnouncementsService.banner', () => {
  it('is empty when nothing has happened — nothing is invented', async () => {
    expect(await build().svc.banner()).toEqual([]);
  });

  it("puts the admin's messages first, then the real biggest win and gift", async () => {
    const { svc } = build({
      custom: [{ id: 'c1', text: 'Weekend PK tournament!' }],
      wins: [{ id: 'e1', userId: 'u1', roundId: 'r1', rewardAmount: 12500 }],
      gifts: [{ id: 't1', senderId: 'u2', recipientId: 'u1', giftId: 'g1', coinAmount: 500 }],
    });
    const items = await svc.banner();
    expect(items.map((i) => i.kind)).toEqual(['CUSTOM', 'BIG_WIN', 'TOP_GIFT']);
    expect(items[1].text).toBe('🏆 Ada just won 12,500 coins in Crash');
    expect(items[2].text).toBe('🎁 Bo sent Rose (500 coins) to Ada');
  });

  it('only asks for messages that are active and inside their date window', async () => {
    const { svc, prisma } = build();
    await svc.banner(Date.UTC(2026, 8, 20));
    const where = prisma.announcement.findMany.mock.calls[0][0].where;
    expect(where.active).toBe(true);
    expect(JSON.stringify(where.AND)).toContain('startsAt');
    expect(JSON.stringify(where.AND)).toContain('endsAt');
  });

  it('caches for 30 seconds so a busy app does not query on every screen', async () => {
    const { svc, prisma } = build();
    await svc.banner(1_000_000);
    await svc.banner(1_010_000);
    expect(prisma.announcement.findMany).toHaveBeenCalledTimes(1);
    await svc.banner(1_040_000);
    expect(prisma.announcement.findMany).toHaveBeenCalledTimes(2);
  });

  it('a change made in the admin shows immediately (cache cleared)', async () => {
    const { svc, prisma } = build();
    await svc.banner(1_000_000);
    await svc.create({ text: 'New announcement' }, 'admin', ['SUPER_ADMIN'] as any);
    await svc.banner(1_001_000);
    expect(prisma.announcement.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('announcement admin actions are audited', () => {
  it('create, update and delete each write an audit entry', async () => {
    const { svc, audit } = build({ existing: { id: 'a1', text: 'old' } });
    await svc.create({ text: 'New one here' }, 'admin', ['SUPER_ADMIN'] as any);
    await svc.update('a1', { text: 'Changed text' }, 'admin', ['SUPER_ADMIN'] as any);
    await svc.remove('a1', 'admin', ['SUPER_ADMIN'] as any);
    expect(audit.record.mock.calls.map((c: any) => c[0].action)).toEqual(['announcement.create', 'announcement.update', 'announcement.delete']);
  });
});
