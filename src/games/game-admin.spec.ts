import { ConflictException } from '@nestjs/common';
import { GameAdminService } from './game-admin.service';

const dice = { payoutMultiplier: 9, diceCount: 3, diceSides: 10 };

function build(game: any, inFlight = 0) {
  const prisma: any = {
    gameDefinition: {
      findUnique: jest.fn().mockResolvedValue(game),
      upsert: jest.fn(async ({ update, create }: any) => ({ code: 'SUM_DICE', name: 'Dice', minAge: 18, version: 1, rulesJson: update?.rulesJson ?? create?.rulesJson })),
    },
    gameRound: { count: jest.fn().mockResolvedValue(inFlight) },
  };
  const audit: any = { record: jest.fn() };
  return { svc: new GameAdminService(prisma, audit), prisma, audit };
}
const ROLES: any = ['SUPER_ADMIN'];
const base = { code: 'SUM_DICE', name: 'Dice', minAge: 18, version: 3, status: 'DISABLED', rulesJson: dice };

describe('GameAdminService.upsert', () => {
  it('applies a valid rules change to a paused game, bumps the version, and audits before/after', async () => {
    const { svc, prisma, audit } = build(base);
    await svc.upsert('SUM_DICE', { name: 'Dice', rulesJson: { ...dice, payoutMultiplier: 11, maxStake: 5000 } }, 'admin', ROLES);
    const update = prisma.gameDefinition.upsert.mock.calls[0][0].update;
    expect(update.rulesJson).toMatchObject({ payoutMultiplier: 11, maxStake: 5000 });
    expect(update.version).toEqual({ increment: 1 });
    const meta = audit.record.mock.calls[0][0].metadata;
    expect(meta.before.rulesJson.payoutMultiplier).toBe(9);
    expect(meta.after.rulesJson.payoutMultiplier).toBe(11);
  });

  it('refuses to change the rules of a game that is live', async () => {
    const { svc, prisma } = build({ ...base, status: 'ACTIVE' });
    await expect(svc.upsert('SUM_DICE', { name: 'Dice', rulesJson: { ...dice, payoutMultiplier: 11 } }, 'a', ROLES)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.gameDefinition.upsert).not.toHaveBeenCalled();
  });

  it('refuses while a round is still in progress, so nobody is paid by rules they did not bet under', async () => {
    const { svc, prisma } = build({ ...base, status: 'MAINTENANCE' }, 1);
    await expect(svc.upsert('SUM_DICE', { name: 'Dice', rulesJson: { ...dice, payoutMultiplier: 11 } }, 'a', ROLES)).rejects.toThrow(/round is still in progress/);
    expect(prisma.gameDefinition.upsert).not.toHaveBeenCalled();
  });

  it('allows a rename on a live game (nothing money-related changes) without bumping the version', async () => {
    const { svc, prisma } = build({ ...base, status: 'ACTIVE' });
    await svc.upsert('SUM_DICE', { name: 'Big Small', rulesJson: dice }, 'a', ROLES);
    expect(prisma.gameDefinition.upsert.mock.calls[0][0].update.version).toBeUndefined();
  });

  it('rejects an unsafe multiplier before touching anything', async () => {
    const { svc, prisma } = build(base);
    await expect(svc.upsert('SUM_DICE', { name: 'Dice', rulesJson: { ...dice, payoutMultiplier: 20 } }, 'a', ROLES)).rejects.toThrow(/too high/);
    expect(prisma.gameDefinition.upsert).not.toHaveBeenCalled();
  });
});
