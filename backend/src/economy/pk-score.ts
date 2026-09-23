import type { PrismaService } from '../prisma/prisma.service';

// PK scoring rules, shared by GiftService (which applies them), the economy
// controller (which broadcasts the new score) and PkService (which serves
// the battle to screens). Kept free of Nest DI so Economy and PK can both
// use it without a circular module dependency.

export type PkSide = 'CHALLENGER' | 'OPPONENT';

// A gift counts for the side of the host who RECEIVED it. (It used to count
// for the host who SENT it, so viewers' gifts never moved the score at all.)
export function pkSideForRecipient(
  battle: { challengerId: string; opponentId: string },
  recipientId: string,
): PkSide | null {
  if (recipientId === battle.challengerId) return 'CHALLENGER';
  if (recipientId === battle.opponentId) return 'OPPONENT';
  return null;
}

export function pkPointsForCoins(coinAmount: number, coinsPerPoint: number): bigint {
  const per = Number.isInteger(coinsPerPoint) && coinsPerPoint > 0 ? coinsPerPoint : 1;
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) return 0n;
  return BigInt(Math.floor(coinAmount / per));
}

export interface PkSupporter {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  coins: number;
}

// Top supporters per host for one battle: who sent the most gift coins to
// each side. Keyed by the host's user id.
export async function loadPkSupporters(
  prisma: PrismaService,
  battle: { id: string; challengerId: string; opponentId: string },
  perSide = 3,
): Promise<Record<string, PkSupporter[]>> {
  const rows = await prisma.giftTransaction.groupBy({
    by: ['recipientId', 'senderId'],
    where: { pkBattleId: battle.id, recipientId: { in: [battle.challengerId, battle.opponentId] } },
    _sum: { coinAmount: true },
    orderBy: { _sum: { coinAmount: 'desc' } },
    take: 100,
  });
  const bySide: Record<string, { senderId: string; coins: number }[]> = {
    [battle.challengerId]: [],
    [battle.opponentId]: [],
  };
  for (const r of rows) {
    const list = bySide[r.recipientId];
    if (list && list.length < perSide) list.push({ senderId: r.senderId, coins: r._sum.coinAmount ?? 0 });
  }
  const ids = [...new Set(Object.values(bySide).flat().map((s) => s.senderId))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, avatarUrl: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const out: Record<string, PkSupporter[]> = {};
  for (const [hostId, list] of Object.entries(bySide)) {
    out[hostId] = list.map((s) => ({
      userId: s.senderId,
      displayName: byId.get(s.senderId)?.displayName ?? null,
      avatarUrl: byId.get(s.senderId)?.avatarUrl ?? null,
      coins: s.coins,
    }));
  }
  return out;
}
