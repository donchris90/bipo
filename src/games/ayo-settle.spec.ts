import { AyoService } from './ayo.service';
import { WalletService } from '../economy/wallet.service';
import { RoundService } from './round.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ConfigService } from '@nestjs/config';
import { WalletType } from '@prisma/client';

function build() {
  const wallets = new Map<string, any>();
  const ledger = new Set<string>();
  const gameRounds = new Map<string, any>();
  const gameEntries = new Map<string, any>();
  const spectatorBets = new Map<string, any>();
  let seq = 0;

  const prisma: any = {
    gameDefinition: {
      upsert: async ({ create }: any) => ({ code: 'AYO', name: 'Ayo', status: 'DISABLED', version: 1, rulesJson: create.rulesJson }),
    },
    gameRound: {
      update: async ({ where, data }: any) => { const r = gameRounds.get(where.id) ?? { id: where.id }; Object.assign(r, data); gameRounds.set(where.id, r); return r; },
    },
    gameEntry: {
      findMany: async ({ where }: any) => [...gameEntries.values()].filter((e) => e.roundId === where.roundId),
      update: async ({ where, data }: any) => { const e = [...gameEntries.values()].find((x) => x.id === where.id); Object.assign(e, data); return e; },
    },
    ayoSpectatorBet: {
      findMany: async ({ where }: any) => [...spectatorBets.values()].filter((b) => b.matchId === where.matchId && (!where.status || b.status === where.status)),
      updateMany: async ({ where, data }: any) => {
        const rows = [...spectatorBets.values()].filter((b) => b.matchId === where.matchId && (!where.status || b.status === where.status));
        for (const b of rows) Object.assign(b, data);
        return { count: rows.length };
      },
      update: async ({ where, data }: any) => { const b = spectatorBets.get(where.id); Object.assign(b, data); return b; },
    },
    wallet: {
      findUnique: async ({ where }: any) => {
        const { userId, type } = where.userId_type;
        return [...wallets.values()].find((w) => w.userId === userId && w.type === type) ?? null;
      },
      upsert: async ({ where, create }: any) => {
        const { userId, type } = where.userId_type;
        let w = [...wallets.values()].find((x) => x.userId === userId && x.type === type);
        if (!w) { w = { id: `w${++seq}`, balance: 0n, ...create }; wallets.set(w.id, w); }
        return w;
      },
      update: async ({ where, data }: any) => {
        const w = wallets.get(where.id);
        if (data.balance?.increment !== undefined) w.balance += data.balance.increment;
        else if (data.balance !== undefined) w.balance = data.balance;
        return w;
      },
    },
    ledgerEntry: { create: async () => undefined, findUnique: async () => null },
    $transaction: async (fn: any) => fn(prisma),
    $queryRaw: async (q: any) => {
      const id = q?.values?.[0];
      const w = [...wallets.values()].find((x) => x.id === id);
      return w ? [{ id: w.id, balance: w.balance }] : [];
    },
  };

  function seedEntry(roundId: string, userId: string, coinAmount: number, bonusAmount = 0) {
    const e = { id: `e${++seq}`, roundId, userId, coinAmount, bonusAmount };
    gameEntries.set(e.id, e);
    return e;
  }
  function seedBet(matchId: string, userId: string, playerUserId: string, coinAmount: number) {
    const b = { id: `b${++seq}`, matchId, userId, playerUserId, coinAmount, status: 'PLACED', rewardAmount: 0 };
    spectatorBets.set(b.id, b);
    return b;
  }

  return { prisma, wallets, gameEntries, spectatorBets, seedEntry, seedBet };
}

function service(prisma: any) {
  const wallet = new WalletService(prisma);
  return new (AyoService as any)(prisma, wallet, new (RoundService as any)(), new ConfigService(), new (RealtimeGateway as any)());
}

function ayoState(overrides: Record<string, any>) {
  return {
    matchId: 'match-1', roomCode: 'ABC123', entryFee: 100, status: 'FINISHED',
    board: Array(12).fill(0), captured: [25, 23], currentSeat: 0,
    players: [{ userId: 'p1', displayName: 'P1', seat: 0, connected: true }, { userId: 'p2', displayName: 'P2', seat: 1, connected: true }],
    turnNumber: 10, turnStartedAt: new Date().toISOString(), turnExpiresAt: new Date().toISOString(), turnSeconds: 30,
    serverNow: Date.now(), prizePool: 200, prizePayout: 0,
    ...overrides,
  };
}

describe('AyoService.settle — spectator bet payouts', () => {
  it('preserves mixed BONUS/COIN funding when paying a game reward', async () => {
    const { prisma, seedEntry } = build();
    seedEntry('match-1', 'p1', 100, 60);
    seedEntry('match-1', 'p2', 100, 0);
    const svc = service(prisma);
    await (svc as any).settle(ayoState({ winnerUserId: 'p1' }));
    const wallet = new WalletService(prisma);
    // 190 reward split 60/100 bonus funding => 114 BONUS and 76 COIN.
    expect(await wallet.getBalance('p1', WalletType.BONUS)).toBe(114n);
    expect(await wallet.getBalance('p1', WalletType.COIN)).toBe(76n);
  });

  it("credits the winning player their prize AND a 20% bonus from the spectator pool for having backers", async () => {
    const { prisma, seedEntry, seedBet, wallets } = build();
    seedEntry('match-1', 'p1', 100);
    seedEntry('match-1', 'p2', 100);
    seedBet('match-1', 'sender-1', 'p1', 1000); // bet on the winner
    const svc = service(prisma);

    const state = ayoState({ winnerUserId: 'p1' });
    await (svc as any).settle(state);

    const wallet = new WalletService(prisma);
    // Prize: 200 pool * 95% default = 190. Spectator winner bonus: 1000 * 20% = 200.
    expect(await wallet.getBalance('p1', WalletType.COIN)).toBe(190n + 200n);
  });

  it('pays winning spectators proportionally to their stake, and nothing to losing spectators', async () => {
    const { prisma, seedEntry, seedBet } = build();
    seedEntry('match-1', 'p1', 100);
    seedEntry('match-1', 'p2', 100);
    const winnerBacker = seedBet('match-1', 'backer-a', 'p1', 800); // backed the winner
    const loserBacker = seedBet('match-1', 'backer-b', 'p2', 200); // backed the loser
    const svc = service(prisma);

    await (svc as any).settle(ayoState({ winnerUserId: 'p1' }));

    const wallet = new WalletService(prisma);
    // Pool = 1000. platform 10% = 100, winner-player bonus 20% = 200, spectators get 70% = 700.
    // Only backer-a\'s stake (800) is "winning" stake, so they get the full 700-share alone.
    expect(await wallet.getBalance('backer-a', WalletType.COIN)).toBe(700n);
    expect(await wallet.getBalance('backer-b', WalletType.COIN)).toBe(0n);
    expect(winnerBacker.status).toBe('WON');
    expect(loserBacker.status).toBe('LOST');
  });

  it('splits winning-spectator payout proportionally when more than one person backed the winner', async () => {
    const { prisma, seedEntry, seedBet } = build();
    seedEntry('match-1', 'p1', 100);
    seedEntry('match-1', 'p2', 100);
    seedBet('match-1', 'backer-a', 'p1', 600); // 75% of the winning stake
    seedBet('match-1', 'backer-b', 'p1', 200); // 25% of the winning stake
    const svc = service(prisma);

    await (svc as any).settle(ayoState({ winnerUserId: 'p1' }));

    const wallet = new WalletService(prisma);
    // Pool = 800, spectators\' share = 800 - 80 (platform) - 160 (winner bonus) = 560.
    // backer-a: 560 * 600/800 = 420. backer-b: 560 * 200/800 = 140.
    expect(await wallet.getBalance('backer-a', WalletType.COIN)).toBe(420n);
    expect(await wallet.getBalance('backer-b', WalletType.COIN)).toBe(140n);
  });

  it('refunds both players and never pays any spectator bet on a genuine draw', async () => {
    const { prisma, seedEntry, seedBet } = build();
    seedEntry('match-1', 'p1', 100);
    seedEntry('match-1', 'p2', 100);
    const bet = seedBet('match-1', 'backer-a', 'p1', 500);
    const svc = service(prisma);

    await (svc as any).settle(ayoState({ winnerUserId: undefined }));

    const wallet = new WalletService(prisma);
    expect(await wallet.getBalance('p1', WalletType.COIN)).toBe(100n); // refunded entry only
    expect(await wallet.getBalance('p2', WalletType.COIN)).toBe(100n);
    expect(await wallet.getBalance('backer-a', WalletType.COIN)).toBe(0n); // never paid
    expect(bet.status).toBe('PLACED'); // untouched — settle() never even looks at bets on a draw
  });

  it('does nothing extra (no crash, no phantom payouts) when nobody bet on the match at all', async () => {
    const { prisma, seedEntry } = build();
    seedEntry('match-1', 'p1', 100);
    seedEntry('match-1', 'p2', 100);
    const svc = service(prisma);

    await expect((svc as any).settle(ayoState({ winnerUserId: 'p1' }))).resolves.toBeUndefined();

    const wallet = new WalletService(prisma);
    expect(await wallet.getBalance('p1', WalletType.COIN)).toBe(190n); // just the prize, no spectator bonus
  });
});
