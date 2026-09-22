import { SettlementService } from './settlement.service';

// The admin's "payout by winning number" grid (0-27) only ever sets the numbers
// someone actually typed a value into. A number nobody touched must still pay the
// game's normal multiplier — not zero — or a winning player is silently paid
// nothing, and the admin page's own promise ("leave this section unchanged to use
// the game's single default multiplier") would be a lie.

function build(rulesJson: any, rolledSum: number) {
  const round = { id: 'r1', gameCode: 'SUM_DICE', status: 'LOCKED', selectionCount: null };
  const entries = [
    { id: 'e1', userId: 'u1', coinAmount: 100, selection: [rolledSum], bonusAmount: 0, autoCashoutMultiplier: null },
    { id: 'e2', userId: 'u2', coinAmount: 100, selection: [rolledSum === 0 ? 1 : 0], bonusAmount: 0, autoCashoutMultiplier: null }, // picks a losing number
  ];
  const prisma: any = {
    gameRound: {
      findUnique: jest.fn().mockResolvedValue(round),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(async ({ data }: any) => ({ ...round, ...data })),
    },
    gameDefinition: { findUnique: jest.fn().mockResolvedValue({ code: 'SUM_DICE', rulesJson }) },
    gameEntry: {
      findMany: jest.fn().mockResolvedValue(entries),
      update: jest.fn(async ({ data }: any) => data),
    },
    $transaction: jest.fn((cb: any) => cb(prisma)),
  };
  // Deterministic draw: every die comes up the same face so the sum is exactly `rolledSum`.
  const perDie = rolledSum / (rulesJson.diceCount ?? 3);
  const rng: any = { randomInRange: jest.fn(() => perDie) };
  const wallet: any = { credit: jest.fn().mockResolvedValue(undefined) };
  return { svc: new SettlementService(prisma, wallet, rng), prisma, wallet };
}

describe('SettlementService — per-number payouts', () => {
  it('a number the admin never customized pays the shared default multiplier, not zero', async () => {
    const { svc, prisma } = build({ diceCount: 3, diceSides: 10, payoutMultiplier: 20, numberPayouts: { '0': 500, '27': 500 } }, 13);
    await svc.settle('r1');
    const winnerUpdate = prisma.gameEntry.update.mock.calls.find((c: any) => c[0].where.id === 'e1')[0].data;
    expect(winnerUpdate).toMatchObject({ status: 'WON', rewardAmount: 100 * 20 }); // the shared 20x, not 0
  });

  it('a number the admin DID customize pays that number\'s own multiplier instead of the shared one', async () => {
    const { svc, prisma } = build({ diceCount: 3, diceSides: 10, payoutMultiplier: 20, numberPayouts: { '0': 500 } }, 0);
    await svc.settle('r1');
    const winnerUpdate = prisma.gameEntry.update.mock.calls.find((c: any) => c[0].where.id === 'e1')[0].data;
    expect(winnerUpdate).toMatchObject({ status: 'WON', rewardAmount: 100 * 500 });
  });

  it('a number explicitly set to 0 really does pay 0 (an intentional admin choice, not a bug)', async () => {
    const { svc, prisma } = build({ diceCount: 3, diceSides: 10, payoutMultiplier: 20, numberPayouts: { '13': 0 } }, 13);
    await svc.settle('r1');
    const winnerUpdate = prisma.gameEntry.update.mock.calls.find((c: any) => c[0].where.id === 'e1')[0].data;
    // rewardAmount 0 means no credit call and a LOST-shaped update, not WON with 0 coins silently
    expect(winnerUpdate.rewardAmount).toBe(0);
  });

  it('with no numberPayouts set at all, every number uses the shared multiplier (unchanged old behaviour)', async () => {
    const { svc, prisma, wallet } = build({ diceCount: 3, diceSides: 10, payoutMultiplier: 9 }, 7);
    await svc.settle('r1');
    const winnerUpdate = prisma.gameEntry.update.mock.calls.find((c: any) => c[0].where.id === 'e1')[0].data;
    expect(winnerUpdate).toMatchObject({ status: 'WON', rewardAmount: 100 * 9 });
    expect(wallet.credit).toHaveBeenCalledTimes(1);
  });

  it('a losing entry never gets paid, whatever numberPayouts says about the winning number', async () => {
    const { svc, prisma, wallet } = build({ diceCount: 3, diceSides: 10, payoutMultiplier: 20, numberPayouts: { '13': 900 } }, 13);
    await svc.settle('r1');
    const loserUpdate = prisma.gameEntry.update.mock.calls.find((c: any) => c[0].where.id === 'e2')[0].data;
    expect(loserUpdate).toMatchObject({ status: 'LOST', rewardAmount: 0 });
    expect(wallet.credit).toHaveBeenCalledTimes(1); // only the winner
  });
});
