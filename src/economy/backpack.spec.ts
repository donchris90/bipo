import { GiftService, groupBackpack } from './gift.service';
import { cleanGiftInput, GiftAdminService } from './gift-admin';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

const OFFSET = 60; // Nigeria, UTC+1
const at = (iso: string) => new Date(iso);
// "Today" is 2026-09-21 in Nigeria (which starts at 2026-09-20T23:00:00Z)
const todayStart = at('2026-09-20T23:00:00Z');
const rose = { id: 'g-rose', code: 'ROSE', name: 'Rose', icon: '🌹' };
const car = { id: 'g-car', code: 'CAR', name: 'Sports Car', icon: '🏎️' };
const gifts = new Map([[rose.id, rose], [car.id, car]]);
const names = new Map<string, string | null>([['ada', 'Ada'], ['bo', 'Bo'], ['ghost', null]]);

describe('groupBackpack — gifts received, day by day', () => {
  const rows = [
    { giftId: 'g-rose', senderId: 'ada', coinAmount: 10, createdAt: at('2026-09-21T08:00:00Z') }, // today
    { giftId: 'g-rose', senderId: 'ada', coinAmount: 10, createdAt: at('2026-09-21T09:00:00Z') },
    { giftId: 'g-rose', senderId: 'bo', coinAmount: 10, createdAt: at('2026-09-21T10:00:00Z') },
    { giftId: 'g-car', senderId: 'ghost', coinAmount: 1000, createdAt: at('2026-09-21T11:00:00Z') },
    { giftId: 'g-rose', senderId: 'bo', coinAmount: 10, createdAt: at('2026-09-20T12:00:00Z') }, // yesterday
  ];

  it("today comes first and lists each gift with how many, what it was worth and who sent it", () => {
    const days = groupBackpack(rows, gifts, names, todayStart, OFFSET, 3);
    expect(days.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-20', '2026-09-19']);
    const today = days[0];
    expect(today).toMatchObject({ isToday: true, totalCount: 4, totalCoins: 1030 });
    expect(today.gifts.map((g) => g.name)).toEqual(['Sports Car', 'Rose']); // most valuable first
    const r = today.gifts.find((g) => g.name === 'Rose')!;
    expect(r).toMatchObject({ count: 3, coinValue: 30, icon: '🌹' });
    expect(r.senders).toEqual([{ userId: 'ada', displayName: 'Ada', count: 2 }, { userId: 'bo', displayName: 'Bo', count: 1 }]);
  });

  it('earlier days are separate, and a day with nothing received is an empty day', () => {
    const days = groupBackpack(rows, gifts, names, todayStart, OFFSET, 3);
    expect(days[1]).toMatchObject({ isToday: false, totalCount: 1, totalCoins: 10 });
    expect(days[2]).toMatchObject({ totalCount: 0, gifts: [] });
  });

  it('the day changes at midnight Nigeria time, not UTC', () => {
    const late = [{ giftId: 'g-rose', senderId: 'ada', coinAmount: 10, createdAt: at('2026-09-20T23:30:00Z') }]; // 00:30 on the 21st in Lagos
    expect(groupBackpack(late, gifts, names, todayStart, OFFSET, 2)[0].totalCount).toBe(1);
    const before = [{ giftId: 'g-rose', senderId: 'ada', coinAmount: 10, createdAt: at('2026-09-20T22:30:00Z') }]; // 23:30 on the 20th
    expect(groupBackpack(before, gifts, names, todayStart, OFFSET, 2)[0].totalCount).toBe(0);
  });

  it('a sender without a name and a gift that was removed still show up, never as an id', () => {
    const odd = [{ giftId: 'gone', senderId: 'ghost', coinAmount: 5, createdAt: at('2026-09-21T08:00:00Z') }];
    const g = groupBackpack(odd, gifts, names, todayStart, OFFSET, 1)[0].gifts[0];
    expect(g.name).toBe('Gift');
    expect(g.senders[0].displayName).toBeNull();
  });
});

describe('GiftService.backpack', () => {
  it('asks only for gifts this person received, within the span, and returns the grouped days', async () => {
    const findMany = jest.fn().mockResolvedValue([{ giftId: 'g-rose', senderId: 'ada', coinAmount: 10, createdAt: at('2026-09-21T08:00:00Z') }]);
    const prisma: any = {
      giftTransaction: { findMany },
      gift: { findMany: jest.fn().mockResolvedValue([rose]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'ada', displayName: 'Ada' }]) },
    };
    const svc = new GiftService(prisma, {} as any, {} as any);
    const days = await svc.backpack('me', 2, at('2026-09-21T12:00:00Z'));
    expect(findMany.mock.calls[0][0].where.recipientId).toBe('me');
    expect(findMany.mock.calls[0][0].where.createdAt.gte).toEqual(at('2026-09-19T23:00:00Z')); // start of yesterday, Lagos
    expect(days).toHaveLength(2);
    expect(days[0].gifts[0]).toMatchObject({ name: 'Rose', count: 1 });
  });
});

describe('admin gift catalogue', () => {
  const good = { code: 'diamond', name: 'Diamond', coinPrice: 300, icon: '💎', category: 'premium' };

  it('validates a new gift', () => {
    expect(cleanGiftInput(good, true)).toMatchObject({ code: 'DIAMOND', coinPrice: 300, icon: '💎', active: true });
    expect(() => cleanGiftInput({ ...good, coinPrice: 0 }, true)).toThrow(/coinPrice/);
    expect(() => cleanGiftInput({ ...good, coinPrice: 1.5 }, true)).toThrow(/coinPrice/);
    expect(() => cleanGiftInput({ ...good, icon: '' }, true)).toThrow(/icon/);
    expect(() => cleanGiftInput({ ...good, name: '' }, true)).toThrow(/name/);
    expect(() => cleanGiftInput({ ...good, code: 'no spaces!' }, true)).toThrow(/code/);
    expect(() => cleanGiftInput(null, true)).toThrow(BadRequestException);
  });

  const build = (existing: any = null) => {
    const prisma: any = { gift: { findUnique: jest.fn().mockResolvedValue(existing), create: jest.fn(async ({ data }: any) => ({ id: 'g1', ...data })), update: jest.fn(async ({ data }: any) => ({ id: 'g1', ...data })) } };
    const audit: any = { record: jest.fn() };
    return { svc: new GiftAdminService(prisma, audit), prisma, audit };
  };

  it('creates a gift, audits it, and refuses a duplicate code', async () => {
    const { svc, audit } = build();
    await svc.create(good, 'admin', ['SUPER_ADMIN'] as any);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'gift.create' }));
    await expect(build({ id: 'x' }).svc.create(good, 'admin', [] as any)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a price change is audited with before and after, and the code can never change', async () => {
    const { svc, prisma, audit } = build({ id: 'g1', code: 'ROSE', name: 'Rose', coinPrice: 10, icon: '🌹', active: true });
    await svc.update('g1', { code: 'HACK', name: 'Rose', coinPrice: 25, icon: '🌹' }, 'admin', ['FINANCE_ADMIN'] as any);
    expect(prisma.gift.update.mock.calls[0][0].data).not.toHaveProperty('code');
    const meta = audit.record.mock.calls[0][0].metadata;
    expect(meta.before.coinPrice).toBe(10);
    expect(meta.after.coinPrice).toBe(25);
    await expect(build(null).svc.update('nope', good, 'a', [] as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});
