import { RoundService } from './round.service';
import { SettlementService } from './settlement.service';

// Regression tests for the "games are stuck" failure: Redis unreachable made
// createRound hang forever, the round never opened, and the scheduler refused
// to start another. Plus the money paths the recovery code added.

describe('RoundService.createRound with an unreachable queue', () => {
  afterEach(() => jest.useRealTimers());

  function build(queueAdd: jest.Mock) {
    const created = { id: 'r1', gameCode: 'SUM_DICE', status: 'SCHEDULED', hiddenState: null };
    const prisma: any = {
      gameDefinition: { findUnique: jest.fn().mockResolvedValue({ code: 'SUM_DICE', rulesJson: { diceCount: 3, diceSides: 10, payoutMultiplier: 9 } }) },
      gameRound: { create: jest.fn().mockResolvedValue(created), update: jest.fn() },
    };
    const rng: any = { generateSecret: () => 'secret', commitmentHash: () => 'hash' };
    const svc = new RoundService(prisma, {} as any, {} as any, rng, {} as any, { add: queueAdd } as any);
    return { svc, prisma };
  }

  it('still returns the round (does not hang, does not cancel it) when queue.add never resolves', async () => {
    jest.useFakeTimers();
    const { svc, prisma } = build(jest.fn().mockReturnValue(new Promise(() => {}))); // Redis never answers

    const now = Date.now();
    const pending = svc.createRound({ gameCode: 'SUM_DICE', rulesVersion: 1, entryPrice: 10, openAt: new Date(now), lockAt: new Date(now + 30_000) });
    await jest.advanceTimersByTimeAsync(3500);

    await expect(pending).resolves.toMatchObject({ id: 'r1' });
    expect(prisma.gameRound.update).not.toHaveBeenCalled(); // not cancelled: the scheduler will drive it
  });

  it('still returns the round when queue.add rejects', async () => {
    const { svc } = build(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const now = Date.now();
    await expect(
      svc.createRound({ gameCode: 'SUM_DICE', rulesVersion: 1, entryPrice: 10, openAt: new Date(now), lockAt: new Date(now + 30_000) }),
    ).resolves.toMatchObject({ id: 'r1' });
  });

  it('never returns the crash point', async () => {
    const { svc } = build(jest.fn().mockResolvedValue({}));
    const now = Date.now();
    const round = await svc.createRound({ gameCode: 'SUM_DICE', rulesVersion: 1, entryPrice: 10, openAt: new Date(now), lockAt: new Date(now + 30_000) });
    expect(round).not.toHaveProperty('hiddenState');
  });
});

describe('SettlementService.voidRound', () => {
  function build(claimCount: number, entries: any[]) {
    const tx: any = { gameEntry: { update: jest.fn() } };
    const prisma: any = {
      gameRound: { updateMany: jest.fn().mockResolvedValue({ count: claimCount }), update: jest.fn() },
      gameEntry: { findMany: jest.fn().mockResolvedValue(entries) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const wallet: any = { credit: jest.fn().mockResolvedValue({}) };
    return { svc: new SettlementService(prisma, wallet, {} as any), prisma, wallet, tx };
  }

  it('refunds coin and bonus stakes to the wallets they came from, then cancels the round', async () => {
    const { svc, wallet, tx, prisma } = build(1, [{ id: 'e1', userId: 'u1', coinAmount: 100, bonusAmount: 30 }]);
    await expect(svc.voidRound('r1')).resolves.toEqual({ refunded: 1 });

    const credits = wallet.credit.mock.calls.map(([mv]: any[]) => ({ type: mv.walletType, amount: mv.amount, key: mv.idempotencyKey }));
    expect(credits).toEqual([
      { type: 'COIN', amount: 70n, key: 'game_refund:e1' },
      { type: 'BONUS', amount: 30n, key: 'game_refund_bonus:e1' },
    ]);
    expect(tx.gameEntry.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { status: 'REFUNDED', rewardAmount: 0 } });
    expect(prisma.gameRound.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { status: 'CANCELLED' } });
  });

  it('total refunded equals total staked', async () => {
    const entries = [
      { id: 'a', userId: 'u1', coinAmount: 10, bonusAmount: 0 },
      { id: 'b', userId: 'u2', coinAmount: 250, bonusAmount: 250 },
      { id: 'c', userId: 'u3', coinAmount: 999, bonusAmount: 1 },
    ];
    const { svc, wallet } = build(1, entries);
    await svc.voidRound('r1');
    const refunded = wallet.credit.mock.calls.reduce((sum: bigint, [mv]: any[]) => sum + mv.amount, 0n);
    expect(refunded).toBe(BigInt(10 + 250 + 999));
  });

  it('does nothing if another process already claimed the round (no double refund)', async () => {
    const { svc, wallet, prisma } = build(0, [{ id: 'e1', userId: 'u1', coinAmount: 100, bonusAmount: 0 }]);
    await expect(svc.voidRound('r1')).resolves.toEqual({ refunded: 0 });
    expect(prisma.gameEntry.findMany).not.toHaveBeenCalled();
    expect(wallet.credit).not.toHaveBeenCalled();
  });
});

describe('SettlementService.settle race', () => {
  it('does not draw or pay if another process already claimed the round', async () => {
    const round = { id: 'r1', gameCode: 'SUM_DICE', status: 'LOCKED', selectionCount: null };
    const prisma: any = {
      gameRound: {
        findUnique: jest.fn().mockResolvedValue(round),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // lost the claim
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...round, status: 'RESOLVING' }),
      },
      gameEntry: { findMany: jest.fn() },
      gameDefinition: { findUnique: jest.fn() },
    };
    const rng: any = { randomInRange: jest.fn() };
    const svc = new SettlementService(prisma, { credit: jest.fn() } as any, rng);

    await svc.settle('r1');

    expect(rng.randomInRange).not.toHaveBeenCalled();
    expect(prisma.gameEntry.findMany).not.toHaveBeenCalled();
  });
});
