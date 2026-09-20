import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface BannerItem {
  id: string;
  kind: 'CUSTOM' | 'BIG_WIN' | 'TOP_GIFT';
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 30_000;
const MAX_TEXT = 200;
const coins = (n: number) => n.toLocaleString('en-US');

// "🏆 Ada just won 12,500 coins in Crash" — a name is shown only when the person
// has one; otherwise a neutral word, never an id.
export const winText = (name: string | null, amount: number, game: string) => `🏆 ${name ?? 'A player'} just won ${coins(amount)} coins in ${game}`;
export const giftText = (sender: string | null, gift: string, recipient: string | null, amount: number) =>
  `🎁 ${sender ?? 'Someone'} sent ${gift} (${coins(amount)} coins) to ${recipient ?? 'a host'}`;

export function cleanAnnouncement(body: any) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (text.length < 3 || text.length > MAX_TEXT) throw new BadRequestException(`text must be 3 to ${MAX_TEXT} characters`);
  const priority = body?.priority === undefined ? 0 : body.priority;
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new BadRequestException('priority must be a whole number from -100 to 100');
  const date = (v: unknown, name: string) => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} must be a date`);
    return d;
  };
  const startsAt = date(body?.startsAt, 'startsAt');
  const endsAt = date(body?.endsAt, 'endsAt');
  if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');
  if (body?.active !== undefined && typeof body.active !== 'boolean') throw new BadRequestException('active must be true or false');
  return { text, priority, startsAt, endsAt, active: body?.active ?? true };
}

@Injectable()
export class AnnouncementsService {
  private cache: { at: number; items: BannerItem[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // What the app's scrolling strip shows: the admin's own messages first, then
  // what really just happened on the platform (the biggest recent win and gift).
  // Nothing is invented — with no activity the strip is simply empty.
  async banner(now = Date.now()): Promise<BannerItem[]> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.items;
    const at = new Date(now);
    const since = new Date(now - DAY_MS);

    const custom = await this.prisma.announcement.findMany({
      where: {
        active: true,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: at } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: at } }] }],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });

    const items: BannerItem[] = custom.map((a) => ({ id: `a:${a.id}`, kind: 'CUSTOM', text: a.text }));
    items.push(...(await this.bigWins(since)), ...(await this.topGifts(since)));

    this.cache = { at: now, items };
    return items;
  }

  private async bigWins(since: Date): Promise<BannerItem[]> {
    const wins = await this.prisma.gameEntry.findMany({
      where: { status: 'WON', createdAt: { gte: since }, rewardAmount: { gt: 0 } },
      orderBy: { rewardAmount: 'desc' },
      take: 2,
      select: { id: true, userId: true, roundId: true, rewardAmount: true },
    });
    if (wins.length === 0) return [];
    const [users, rounds] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: wins.map((w) => w.userId) } }, select: { id: true, displayName: true } }),
      this.prisma.gameRound.findMany({ where: { id: { in: wins.map((w) => w.roundId) } }, select: { id: true, gameCode: true } }),
    ]);
    const codes = [...new Set(rounds.map((r) => r.gameCode))];
    const games = await this.prisma.gameDefinition.findMany({ where: { code: { in: codes } }, select: { code: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    const gameOfRound = new Map(rounds.map((r) => [r.id, games.find((g) => g.code === r.gameCode)?.name ?? r.gameCode]));
    return wins.map((w) => ({ id: `w:${w.id}`, kind: 'BIG_WIN' as const, text: winText(name.get(w.userId) ?? null, w.rewardAmount, gameOfRound.get(w.roundId) ?? 'a game') }));
  }

  private async topGifts(since: Date): Promise<BannerItem[]> {
    const gifts = await this.prisma.giftTransaction.findMany({
      where: { createdAt: { gte: since }, context: { in: ['LIVE', 'ROOM'] } },
      orderBy: { coinAmount: 'desc' },
      take: 1,
      select: { id: true, senderId: true, recipientId: true, giftId: true, coinAmount: true },
    });
    if (gifts.length === 0) return [];
    const g = gifts[0];
    const [users, gift] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: [g.senderId, g.recipientId] } }, select: { id: true, displayName: true } }),
      this.prisma.gift.findUnique({ where: { id: g.giftId }, select: { name: true } }),
    ]);
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    return [{ id: `g:${g.id}`, kind: 'TOP_GIFT', text: giftText(name.get(g.senderId) ?? null, gift?.name ?? 'a gift', name.get(g.recipientId) ?? null, g.coinAmount) }];
  }

  // ── admin ─────────────────────────────────────────────────────

  list() {
    return this.prisma.announcement.findMany({ orderBy: [{ active: 'desc' }, { priority: 'desc' }, { createdAt: 'desc' }], take: 100 });
  }

  async create(body: unknown, actorId: string, roles: RoleName[]) {
    const data = cleanAnnouncement(body);
    const row = await this.prisma.announcement.create({ data: { ...data, createdBy: actorId } });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'announcement.create', targetType: 'announcement', targetId: row.id, metadata: { text: row.text } as any });
    this.cache = null;
    return row;
  }

  async update(id: string, body: unknown, actorId: string, roles: RoleName[]) {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found');
    const data = cleanAnnouncement(body);
    const row = await this.prisma.announcement.update({ where: { id }, data });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'announcement.update', targetType: 'announcement', targetId: id, metadata: { before: existing.text, after: row.text, active: row.active } as any });
    this.cache = null;
    return row;
  }

  async remove(id: string, actorId: string, roles: RoleName[]) {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found');
    await this.prisma.announcement.delete({ where: { id } });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'announcement.delete', targetType: 'announcement', targetId: id, metadata: { text: existing.text } as any });
    this.cache = null;
    return { deleted: true };
  }
}
