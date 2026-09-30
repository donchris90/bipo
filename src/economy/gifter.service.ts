import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type GifterPeriod = 'today' | 'week' | 'month' | 'all';

// Global gifter progression is derived from the immutable GiftTransaction ledger.
// This deliberately does not add a second balance that can drift away from the ledger.
const TIERS = [
  { level: 0, name: 'New Gifter', minCoins: 0, vip: false },
  { level: 1, name: 'Supporter', minCoins: 1_000, vip: false },
  { level: 2, name: 'VIP 1', minCoins: 10_000, vip: true },
  { level: 3, name: 'VIP 2', minCoins: 50_000, vip: true },
  { level: 4, name: 'VIP 3', minCoins: 200_000, vip: true },
  { level: 5, name: 'VIP 4', minCoins: 1_000_000, vip: true },
];

export function tierFor(coins: number) {
  return [...TIERS].reverse().find((tier) => coins >= tier.minCoins) ?? TIERS[0];
}

function sinceFor(period: GifterPeriod): Date | undefined {
  if (period === 'all') return undefined;
  const days = period === 'today' ? 1 : period === 'week' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class GifterService {
  constructor(private readonly prisma: PrismaService) {}

  tiers() {
    return TIERS;
  }

  async status(userId: string) {
    const aggregate = await this.prisma.giftTransaction.aggregate({
      where: { senderId: userId },
      _sum: { coinAmount: true },
      _count: { _all: true },
    });
    const lifetimeCoins = aggregate._sum.coinAmount ?? 0;
    const tier = tierFor(lifetimeCoins);
    const next = TIERS.find((item) => item.minCoins > lifetimeCoins) ?? null;
    return {
      userId,
      lifetimeCoins,
      giftCount: aggregate._count._all,
      level: tier.level,
      tier: tier.name,
      vip: tier.vip,
      nextTier: next ? { level: next.level, name: next.name, minCoins: next.minCoins } : null,
      remainingToNext: next ? Math.max(0, next.minCoins - lifetimeCoins) : 0,
    };
  }

  async ranking(period: GifterPeriod = 'today', limit = 50) {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50));
    const since = sinceFor(period);
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['senderId'],
      where: since ? { createdAt: { gte: since } } : {},
      _sum: { coinAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { coinAmount: 'desc' } },
      take: safeLimit,
    });
    if (!rows.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.senderId) } },
      select: { id: true, displayName: true, avatarUrl: true, countryCode: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    return rows.map((row, index) => {
      const coins = row._sum.coinAmount ?? 0;
      const tier = tierFor(coins);
      const user = byId.get(row.senderId);
      return {
        rank: index + 1,
        userId: row.senderId,
        displayName: user?.displayName ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        countryCode: user?.countryCode ?? null,
        coins,
        giftCount: row._count._all,
        level: tier.level,
        tier: tier.name,
        vip: tier.vip,
      };
    });
  }

  async entrance(userId: string) {
    const [status, user] = await Promise.all([
      this.status(userId),
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, avatarUrl: true } }),
    ]);
    return { ...status, displayName: user?.displayName ?? null, avatarUrl: user?.avatarUrl ?? null };
  }
}
