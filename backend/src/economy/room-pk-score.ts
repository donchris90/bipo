import { pkPointsForCoins } from './pk-score';

// Feeds a gift into a running Room PK (multi-guest PK in a party room). Called by GiftService
// after the gift's money transaction has committed, same as the 1v1 applyPkScore: a score is game
// state, so a failure here must never undo a paid gift. Kept free of Nest DI (and of a RoomPk
// service import) so Economy and Rooms don't depend on each other.
//
// Gifts during the pre-start countdown don't count either (startedAt is in the future until it ends).
// Only people who joined the PK at the start (its participants) can score; the increment is guarded on the PK still being ACTIVE and not past endsAt inside the same
// statement, so a gift racing the settle can't change a final score.
export async function applyRoomPkScore(
  prisma: any,
  roomId: string,
  recipientId: string,
  coinAmount: number,
): Promise<void> {
  const now = new Date();
  const active = await prisma.roomPk.findFirst({
    where: { roomId, status: 'ACTIVE', startedAt: { lte: now }, endsAt: { gt: now } },
    select: { id: true },
  });
  if (!active) return;
  // Only someone still seated earns points. A guest who left their seat keeps the score they had
  // (it stays on the board and in a team's pool) but stops accruing, so a PK can't be padded by
  // gifting a person who has already stepped away.
  const seated = await prisma.roomSeat.findFirst({ where: { roomId, userId: recipientId }, select: { id: true } });
  if (!seated) return;
  const scoreConfig = await prisma.pKScoreConfig.findFirst({ where: { active: true }, orderBy: { id: 'desc' } });
  const points = pkPointsForCoins(coinAmount, scoreConfig?.coinsPerPoint ?? 1);
  if (points <= 0n) return;
  await prisma.roomPkParticipant.updateMany({
    where: { roomPkId: active.id, userId: recipientId, roomPk: { status: 'ACTIVE', startedAt: { lte: now }, endsAt: { gt: now } } },
    data: { score: { increment: points } },
  });
}
