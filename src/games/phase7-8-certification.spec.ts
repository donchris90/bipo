import { computeCrashReward, resolveAutoCashout, resolveCashout } from './crash-rules';
import { computeSumDiceReward, isWinningNumber, validateSelection } from './sum-dice-rules';
import { planRoundRecovery } from './round-recovery';
import { SocialService } from '../social/social.service';
import { MessagesService } from '../messages/messages.service';

/**
 * Phase 7–8 certification tests.
 *
 * These are deliberately provider-free: they prove the money/game/social
 * invariants that must hold before live-device/provider testing. Real Redis,
 * PostgreSQL, Agora, push providers and Android devices are covered by the
 * launch runbook, not mocked into a false "production passed" result.
 */
describe('Phase 7 — game certification invariants', () => {
  it('Crash cash-out is server-time based and cannot cash out at/after crash', () => {
    expect(resolveCashout(2, 3, Math.log(2) / 5).success).toBe(true);
    expect(resolveCashout(10, 3, Math.log(2) / 5).success).toBe(false);
  });

  it('Crash auto-cashout never exceeds the configured crash point', () => {
    expect(resolveAutoCashout(2, 3)).toEqual({ won: true, multiplier: 2 });
    expect(resolveAutoCashout(4, 3)).toEqual({ won: false });
  });

  it('Crash reward is derived from the authoritative stake and multiplier', () => {
    expect(computeCrashReward(100, 2.5)).toBe(250);
    expect(computeCrashReward(100, 1)).toBe(100);
  });

  it('Sum Dice rejects malformed selections and accepts valid number selections', () => {
    expect(validateSelection([14], 27)).toEqual({ valid: true });
    expect(validateSelection([], 27).valid).toBe(false);
    expect(validateSelection([28], 27).valid).toBe(false);
    expect(validateSelection([14, 14], 27).valid).toBe(false);
  });

  it('Sum Dice win determination is exact and reward is zero on a loss', () => {
    expect(isWinningNumber([14], 14)).toBe(true);
    expect(isWinningNumber([13], 14)).toBe(false);
    expect(computeSumDiceReward(100, 1, 9, true)).toBe(900);
    expect(computeSumDiceReward(100, 1, 9, false)).toBe(0);
  });

  it('round recovery cancels stale rounds rather than inventing a late result', () => {
    const openAt = new Date('2026-09-21T12:00:00.000Z');
    const lockAt = new Date('2026-09-21T12:01:00.000Z');
    expect(planRoundRecovery({ status: 'OPEN', openAt, lockAt }, { isCrash: false, crashAt: null }, lockAt.getTime() + 61_001)).toBe('void');
    expect(planRoundRecovery({ status: 'OPEN', openAt, lockAt }, { isCrash: false, crashAt: null }, lockAt.getTime() + 1_100)).toBe('lock');
  });
});

describe('Phase 8 — social/communications certification invariants', () => {
  it('follow blocks self-follow and creates the real follow notification', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u2' }) },
      block: { findFirst: jest.fn().mockResolvedValue(null) },
      follow: { create: jest.fn().mockResolvedValue({ followerId: 'u1', followingId: 'u2' }) },
    };
    const notifications: any = { create: jest.fn().mockResolvedValue({}) };
    const audit: any = { record: jest.fn() };
    const svc = new SocialService(prisma, audit, notifications);

    await expect(svc.follow('u1', 'u1')).rejects.toThrow();
    await svc.follow('u1', 'u2');
    expect(prisma.follow.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith('u2', 'FOLLOW', { followerId: 'u1' });
  });

  it('private messaging refuses blocked users before persistence or notification', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u2' }) },
      block: { findFirst: jest.fn().mockResolvedValue({ id: 'b1' }) },
      directMessage: { create: jest.fn() },
    };
    const notifications: any = { create: jest.fn() };
    const realtime: any = { emitToUser: jest.fn() };
    const svc = new MessagesService(prisma, notifications, realtime);

    await expect(svc.send('u1', 'u2', 'hello')).rejects.toThrow();
    expect(prisma.directMessage.create).not.toHaveBeenCalled();
    expect(realtime.emitToUser).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
