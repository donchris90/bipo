import { GiftService } from './gift.service';
import { WalletService } from './wallet.service';
import { RevenueSplitService } from './revenue-split.service';
import { FakePrisma } from '../test-utils/fake-prisma';
import { WalletType } from '@prisma/client';

// Same caveat as wallet.service.spec.ts: not runnable in the sandbox this
// was written in due to the blocked `prisma generate` step. Run
// `npx prisma generate` first.
describe('GiftService', () => {
  function makeService() {
    const prisma = new FakePrisma();
    const wallet = new WalletService(prisma as any);
    const revenueSplit = new RevenueSplitService(prisma as any);
    const gifts = new GiftService(prisma as any, wallet, revenueSplit);

    prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
    prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
    prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });

    return { prisma, wallet, gifts };
  }

  it('debits the sender, credits the recipient their share, and records the platform share (default 70/30 fallback)', async () => {
    const { prisma, wallet, gifts } = makeService();
    await wallet.credit({
      userId: 'sender',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: 'BONUS' as any,
      idempotencyKey: 'seed',
    });

    await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-1' });

    expect(await wallet.getBalance('sender', WalletType.COIN)).toBe(0n);
    expect(await wallet.getBalance('recipient', WalletType.CREATOR_EARNINGS)).toBe(70n);
    const tx = prisma.giftTransactions.get('gift-1');
    expect(tx).toMatchObject({
      coinAmount: 100,
      creatorShareCoins: 70,
      platformShareCoins: 30,
      agencyShareCoins: 0,
      creatorShareBps: 7000,
      platformShareBps: 3000,
      agencyCommissionBps: 0,
    });
  });

  it('rejects sending a gift to yourself', async () => {
    const { gifts } = makeService();
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'sender', giftId: 'rose', idempotencyKey: 'gift-2' }),
    ).rejects.toThrow('Cannot send a gift to yourself');
  });

  it('throws on insufficient balance and does not create a gift transaction', async () => {
    const { prisma, gifts } = makeService();
    // sender has 0 coins — no credit() call
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-3' }),
    ).rejects.toThrow('Insufficient balance');
    expect(prisma.giftTransactions.get('gift-3')).toBeUndefined();
  });

  it('is idempotent: retrying the same key does not double-charge the sender', async () => {
    const { wallet, gifts } = makeService();
    await wallet.credit({
      userId: 'sender',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: 'BONUS' as any,
      idempotencyKey: 'seed',
    });

    const first = await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-4' });
    const second = await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-4' });

    expect(second).toEqual(first);
    expect(await wallet.getBalance('sender', WalletType.COIN)).toBe(0n); // spent once, not twice
  });

  it('rejects sending an inactive or unknown gift', async () => {
    const { prisma, gifts } = makeService();
    prisma.gifts.set('retired', { id: 'retired', coinPrice: 50, active: false });
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'retired', idempotencyKey: 'gift-5' }),
    ).rejects.toThrow('Gift not available');
    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'does-not-exist', idempotencyKey: 'gift-6' }),
    ).rejects.toThrow('Gift not available');
  });

  it('routes a commission to the agency owner when the recipient has an active agency membership', async () => {
    const { prisma, wallet, gifts } = makeService();
    prisma.agencies.set('agency-1', { id: 'agency-1', ownerId: 'agency-owner', status: 'APPROVED' });
    prisma.agencyMemberships.set('recipient', {
      agencyId: 'agency-1',
      creatorId: 'recipient',
      commissionBps: 2000, // 20% of the creator's pool
      status: 'ACTIVE',
    });
    await wallet.credit({
      userId: 'sender',
      walletType: WalletType.COIN,
      amount: 100n,
      ledgerType: 'BONUS' as any,
      idempotencyKey: 'seed',
    });

    await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'gift-7' });

    // 100 coins, 70% creator pool = 70. 20% agency commission of that pool = 14.
    expect(await wallet.getBalance('recipient', WalletType.CREATOR_EARNINGS)).toBe(56n);
    expect(await wallet.getBalance('agency-owner', WalletType.AGENCY_EARNINGS)).toBe(14n);
  });
});

describe('gifts do not create notifications', () => {
  it('a successful gift never calls the notification service (no inbox item, no phone push)', async () => {
    const prisma = new FakePrisma();
    const wallet = new WalletService(prisma as any);
    const notifications: any = { notifyGift: jest.fn(), notify: jest.fn(), notifyOnce: jest.fn() };
    const gifts = new GiftService(prisma as any, wallet, new RevenueSplitService(prisma as any), notifications);
    prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
    prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
    prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });
    await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

    await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'g-1' });

    expect(notifications.notifyGift).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(notifications.notifyOnce).not.toHaveBeenCalled();
    // ...while the money still moves exactly as before
    expect(await wallet.getBalance('recipient', WalletType.CREATOR_EARNINGS)).toBe(70n);
  });
});

describe('gifts contribute to the sender\'s season points', () => {
  it("feeds the sender's full coin amount to SeasonsService, same as the team XP hook", async () => {
    const prisma = new FakePrisma();
    const wallet = new WalletService(prisma as any);
    const seasons: any = { contributePoints: jest.fn().mockResolvedValue(undefined) };
    const gifts = new GiftService(
      prisma as any,
      wallet,
      new RevenueSplitService(prisma as any),
      undefined, undefined, undefined, undefined, undefined, undefined,
      seasons,
    );
    prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
    prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
    prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });
    await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

    await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'g-1' });

    expect(seasons.contributePoints).toHaveBeenCalledWith('sender', 100);
  });

  it('never fails a gift when SeasonsService is absent (constructible without it, like every other optional hook)', async () => {
    const prisma = new FakePrisma();
    const wallet = new WalletService(prisma as any);
    const gifts = new GiftService(prisma as any, wallet, new RevenueSplitService(prisma as any));
    prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
    prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
    prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });
    await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

    await expect(
      gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'g-2' }),
    ).resolves.toBeDefined();
  });

  // Regression coverage for a real production bug: RoomSeat had no `giftCoins` column, so this
  // exact call — issued from inside the same $transaction as the wallet debit/credit and the
  // GiftTransaction record — threw a Prisma validation error and rolled back the WHOLE gift, not
  // just a display number. Fixed by adding the column (see the matching migration). FakePrisma
  // had no roomSeat model at all before this, which is exactly how this path went untested.
  describe('ROOM-context gifts and the seat gift total', () => {
    function seatedService() {
      const prisma = new FakePrisma();
      const wallet = new WalletService(prisma as any);
      const gifts = new GiftService(prisma as any, wallet, new RevenueSplitService(prisma as any));
      prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
      prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
      prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });
      prisma.roomSeats.set('room-1:recipient', { roomId: 'room-1', userId: 'recipient', seatNumber: 3, giftCoins: 0 });
      return { prisma, wallet, gifts };
    }

    function unseatedService() {
      const prisma = new FakePrisma();
      const wallet = new WalletService(prisma as any);
      const gifts = new GiftService(prisma as any, wallet, new RevenueSplitService(prisma as any));
      prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
      prisma.users.set('recipient', { id: 'recipient', countryCode: 'NG' });
      prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });
      return { prisma, wallet, gifts }; // no seat set up at all
    }

    it('increments the recipient seat\'s running total by the gift\'s coin price', async () => {
      const { prisma, wallet, gifts } = seatedService();
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', context: 'ROOM' as any, contextId: 'room-1', idempotencyKey: 'g-room-1' });

      expect(prisma.roomSeats.get('room-1:recipient').giftCoins).toBe(100);
    });

    it('accumulates across repeated gifts in the same sitting', async () => {
      const { prisma, wallet, gifts } = seatedService();
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 300n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', context: 'ROOM' as any, contextId: 'room-1', idempotencyKey: 'g-room-a' });
      await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', context: 'ROOM' as any, contextId: 'room-1', idempotencyKey: 'g-room-b' });

      expect(prisma.roomSeats.get('room-1:recipient').giftCoins).toBe(200);
    });

    it('still completes the gift — and does not touch any seat — when the recipient is not actually seated in that room', async () => {
      const { prisma, wallet, gifts } = unseatedService();
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      const tx = await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', context: 'ROOM' as any, contextId: 'room-1', idempotencyKey: 'g-room-c' });

      expect(tx).toBeDefined();
      expect(prisma.roomSeats.size).toBe(0);
    });

    it('never touches a seat total for a non-ROOM gift, even to the same recipient', async () => {
      const { prisma, wallet, gifts } = seatedService();
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'recipient', giftId: 'rose', idempotencyKey: 'g-no-context' });

      expect(prisma.roomSeats.get('room-1:recipient').giftCoins).toBe(0);
    });
  });

  // Regression + first-ever coverage for the PK score pooling itself: resolvePkBattleId and
  // applyPkScore existed and were already live in production, but FakePrisma had no pKBattle,
  // liveSession, or teamMember support at all — so NONE of this logic, old (Team PK) or new
  // (Family/Guild PK), had ever actually been exercised by a test before now.
  describe('PK score pooling — Team and Family/Guild', () => {
    function pkService() {
      const prisma = new FakePrisma();
      const wallet = new WalletService(prisma as any);
      const gifts = new GiftService(prisma as any, wallet, new RevenueSplitService(prisma as any));
      prisma.users.set('sender', { id: 'sender', countryCode: 'NG' });
      prisma.gifts.set('rose', { id: 'rose', coinPrice: 100, active: true });
      return { prisma, wallet, gifts };
    }

    function activeBattle(prisma: FakePrisma, overrides: Record<string, any>) {
      const battle = {
        id: 'battle-1', challengerId: 'leader-a', opponentId: 'leader-b',
        status: 'ACTIVE', mode: 'NORMAL', startedAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000),
        scoreChallenger: 0n, scoreOpponent: 0n,
        ...overrides,
      };
      prisma.pkBattles.set(battle.id, battle);
      return battle;
    }

    it('a direct gift to a 1v1 PK leader scores immediately, no team/agency lookup needed', async () => {
      const { prisma, wallet, gifts } = pkService();
      activeBattle(prisma, {});
      prisma.users.set('leader-a', { id: 'leader-a', countryCode: 'NG' });
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'leader-a', giftId: 'rose', context: 'LIVE' as any, idempotencyKey: 'g-1' });

      expect(prisma.pkBattles.get('battle-1').scoreChallenger).toBe(100n);
    });

    it("Team PK: a gift to a member (not the leader) pools into their team's side, but only while THEY are hosting the live it was sent in", async () => {
      const { prisma, wallet, gifts } = pkService();
      activeBattle(prisma, { mode: 'TEAM', challengerId: 'leader-a', opponentId: 'leader-b', challengerTeamId: 'team-x', opponentTeamId: 'team-y' });
      prisma.users.set('member', { id: 'member', countryCode: 'NG' });
      prisma.teamMembers.set('member', { userId: 'member', teamId: 'team-y' });
      prisma.liveSessions.set('session-1', { id: 'session-1', hostId: 'member', status: 'LIVE' });
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'member', giftId: 'rose', context: 'LIVE' as any, contextId: 'session-1', idempotencyKey: 'g-2' });

      expect(prisma.pkBattles.get('battle-1').scoreOpponent).toBe(100n);
      expect(prisma.pkBattles.get('battle-1').scoreChallenger).toBe(0n);
    });

    it("Team PK: the SAME gift does NOT count if the member isn't actually hosting the live it was sent in", async () => {
      const { prisma, wallet, gifts } = pkService();
      activeBattle(prisma, { mode: 'TEAM', challengerTeamId: 'team-x', opponentTeamId: 'team-y' });
      prisma.users.set('member', { id: 'member', countryCode: 'NG' });
      prisma.teamMembers.set('member', { userId: 'member', teamId: 'team-y' });
      prisma.liveSessions.set('session-1', { id: 'session-1', hostId: 'someone-else', status: 'LIVE' }); // member isn't the host here
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'member', giftId: 'rose', context: 'LIVE' as any, contextId: 'session-1', idempotencyKey: 'g-3' });

      expect(prisma.pkBattles.get('battle-1').scoreChallenger).toBe(0n);
      expect(prisma.pkBattles.get('battle-1').scoreOpponent).toBe(0n);
    });

    it("Family/Guild PK: a gift to any approved member pools into their agency's side, same hosting rule as Team PK", async () => {
      const { prisma, wallet, gifts } = pkService();
      activeBattle(prisma, { mode: 'AGENCY', challengerId: 'owner-a', opponentId: 'owner-b', challengerAgencyId: 'agency-x', opponentAgencyId: 'agency-y' });
      prisma.users.set('creator', { id: 'creator', countryCode: 'NG' });
      prisma.agencyMemberships.set('creator', { creatorId: 'creator', agencyId: 'agency-y', status: 'ACTIVE' });
      prisma.liveSessions.set('session-2', { id: 'session-2', hostId: 'creator', status: 'LIVE' });
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'creator', giftId: 'rose', context: 'LIVE' as any, contextId: 'session-2', idempotencyKey: 'g-4' });

      expect(prisma.pkBattles.get('battle-1').scoreOpponent).toBe(100n);
    });

    it('Family/Guild PK: a gift to the agency OWNER themself (not just a regular member) also pools correctly', async () => {
      const { prisma, wallet, gifts } = pkService();
      activeBattle(prisma, { mode: 'AGENCY', challengerId: 'someone', opponentId: 'someone-else', challengerAgencyId: 'agency-x', opponentAgencyId: 'agency-y' });
      prisma.users.set('owner', { id: 'owner', countryCode: 'NG' });
      prisma.agencies.set('agency-x', { id: 'agency-x', ownerId: 'owner', status: 'APPROVED' });
      prisma.liveSessions.set('session-3', { id: 'session-3', hostId: 'owner', status: 'LIVE' });
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'owner', giftId: 'rose', context: 'LIVE' as any, contextId: 'session-3', idempotencyKey: 'g-5' });

      expect(prisma.pkBattles.get('battle-1').scoreChallenger).toBe(100n);
    });

    it('Family/Guild PK: does NOT pool if the agency has no active AGENCY-mode battle at all', async () => {
      const { prisma, wallet, gifts } = pkService();
      // no battle set up
      prisma.users.set('creator', { id: 'creator', countryCode: 'NG' });
      prisma.agencyMemberships.set('creator', { creatorId: 'creator', agencyId: 'agency-y', status: 'ACTIVE' });
      prisma.liveSessions.set('session-4', { id: 'session-4', hostId: 'creator', status: 'LIVE' });
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      // Must not throw — the gift itself still succeeds even with no PK to score.
      await expect(
        gifts.send({ senderId: 'sender', recipientId: 'creator', giftId: 'rose', context: 'LIVE' as any, contextId: 'session-4', idempotencyKey: 'g-6' }),
      ).resolves.toBeDefined();
    });

    it('Team and Family/Guild battles never cross-contaminate: an agency-mode battle is invisible to team resolution and vice versa', async () => {
      const { prisma, wallet, gifts } = pkService();
      // Only a TEAM battle for team-y exists; this member is ALSO in agency-y, which has no battle.
      activeBattle(prisma, { mode: 'TEAM', challengerTeamId: 'team-x', opponentTeamId: 'team-y' });
      prisma.users.set('member', { id: 'member', countryCode: 'NG' });
      prisma.teamMembers.set('member', { userId: 'member', teamId: 'team-y' });
      prisma.agencyMemberships.set('member', { creatorId: 'member', agencyId: 'agency-y', status: 'ACTIVE' });
      prisma.liveSessions.set('session-5', { id: 'session-5', hostId: 'member', status: 'LIVE' });
      await wallet.credit({ userId: 'sender', walletType: WalletType.COIN, amount: 100n, ledgerType: 'BONUS' as any, idempotencyKey: 'seed' });

      await gifts.send({ senderId: 'sender', recipientId: 'member', giftId: 'rose', context: 'LIVE' as any, contextId: 'session-5', idempotencyKey: 'g-7' });

      // Resolves via the TEAM battle (checked first) — correctly, since that's the one that's active.
      expect(prisma.pkBattles.get('battle-1').scoreOpponent).toBe(100n);
    });
  });
});
