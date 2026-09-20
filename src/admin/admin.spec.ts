import { BadRequestException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { clampLimit, parseBefore, parseEnumFilter, userSearchWhere } from './admin-query';

describe('admin query helpers', () => {
  it('clamps the page size', () => {
    expect(clampLimit(undefined)).toBe(25);
    expect(clampLimit('abc')).toBe(25);
    expect(clampLimit(0)).toBe(25);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(5000)).toBe(100);
  });

  it('parses the before cursor and rejects garbage', () => {
    expect(parseBefore(undefined)).toBeUndefined();
    expect(parseBefore('2026-09-19T10:00:00Z')?.toISOString()).toBe('2026-09-19T10:00:00.000Z');
    expect(() => parseBefore('yesterday')).toThrow(BadRequestException);
  });

  it('only lets known enum values through to the database', () => {
    const allowed = ['PENDING', 'APPROVED'] as const;
    expect(parseEnumFilter(undefined, allowed, 'PENDING')).toBe('PENDING');
    expect(parseEnumFilter('approved', allowed)).toBe('APPROVED');
    expect(parseEnumFilter('ALL', allowed, 'PENDING')).toBeUndefined();
    expect(() => parseEnumFilter('DROP TABLE', allowed)).toThrow(BadRequestException);
  });

  it('builds a user search over email/name, plus an exact id for a UUID', () => {
    expect(userSearchWhere('')).toEqual({});
    const text = userSearchWhere('ada') as any;
    expect(text.OR).toHaveLength(2);
    const id = userSearchWhere('123e4567-e89b-42d3-a456-426614174000') as any;
    expect(id.OR).toContainEqual({ id: '123e4567-e89b-42d3-a456-426614174000' });
  });
});

function build(prismaOverrides: Record<string, any> = {}) {
  const count = jest.fn().mockResolvedValue(3);
  const prisma: any = {
    user: { count, findMany: jest.fn().mockResolvedValue([]) },
    liveSession: { count },
    partyRoom: { count },
    creatorApplication: { count },
    withdrawalRequest: {
      count,
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 900 } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    agency: { count },
    kycSubmission: { count, findMany: jest.fn().mockResolvedValue([]) },
    coinPurchase: {
      groupBy: jest.fn().mockResolvedValue([{ currencyCode: 'NGN', _sum: { amountMinor: 500000 }, _count: { _all: 4 } }]),
    },
    ...prismaOverrides,
  };
  return { svc: new AdminService(prisma), prisma };
}

describe('AdminService.overview', () => {
  it('sends money figures to finance roles', async () => {
    const { svc } = build();
    const o = await svc.overview([RoleName.FINANCE_ADMIN]);
    expect(o.finance).toEqual({
      purchases30d: [{ currencyCode: 'NGN', amountMinor: 500000, count: 4 }],
      pendingWithdrawalCoins: 900,
    });
  });

  it('never computes or returns money figures for other admin roles', async () => {
    const { svc, prisma } = build();
    const o = await svc.overview([RoleName.TRUST_SAFETY_ADMIN]);
    expect(o.finance).toBeNull();
    expect(prisma.coinPurchase.groupBy).not.toHaveBeenCalled();
    expect(prisma.withdrawalRequest.aggregate).not.toHaveBeenCalled();
  });
});

describe('AdminService lists', () => {
  it('withdrawals default to the review queue and expose coins + risk flags, not the raw column name', async () => {
    const { svc, prisma } = build();
    prisma.withdrawalRequest.findMany.mockResolvedValue([
      { id: 'w1', creatorId: 'u1', walletType: 'CREATOR_EARNINGS', amountMinor: 700, currencyCode: 'NGN', status: 'PENDING_REVIEW', riskFlags: ['NEW_ACCOUNT'], requestedAt: new Date(), decidedAt: null, failureReason: null },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', displayName: 'Ada', email: 'ada@x.com' }]);
    const rows = await svc.withdrawals({});
    expect(prisma.withdrawalRequest.findMany.mock.calls[0][0].where).toEqual({ status: 'PENDING_REVIEW' });
    expect(rows[0]).toMatchObject({ id: 'w1', amountCoins: 700, riskFlags: ['NEW_ACCOUNT'], user: { displayName: 'Ada' } });
    expect((rows[0] as any).amountMinor).toBeUndefined();
  });

  it('users never include password hashes and flatten roles', async () => {
    const { svc, prisma } = build();
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', email: 'a@x.com', displayName: null, countryCode: 'NG', status: 'ACTIVE', kycVerified: false, createdAt: new Date(), roles: [{ role: 'USER' }, { role: 'CREATOR' }] },
    ]);
    const rows = await svc.users({ search: 'a' });
    const select = prisma.user.findMany.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
    expect(rows[0].roles).toEqual(['USER', 'CREATOR']);
  });
});

describe('AdminController access', () => {
  const rolesOf = (method: keyof AdminController): RoleName[] => Reflect.getMetadata(ROLES_KEY, AdminController.prototype[method]);

  it('every route requires an admin role — a normal user or creator is never enough', () => {
    for (const m of ['overview', 'users', 'creatorApplications', 'withdrawals', 'purchases', 'agencies', 'liveSessions', 'auditLog', 'moderationActions', 'games'] as const) {
      const roles = rolesOf(m);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles).not.toContain(RoleName.USER);
      expect(roles).not.toContain(RoleName.CREATOR);
    }
  });

  it('money data is finance-only, moderation data is trust-and-safety, games are game-operator', () => {
    expect(rolesOf('withdrawals').sort()).toEqual([RoleName.FINANCE_ADMIN, RoleName.SUPER_ADMIN].sort());
    expect(rolesOf('purchases')).not.toContain(RoleName.TRUST_SAFETY_ADMIN);
    expect(rolesOf('auditLog')).not.toContain(RoleName.FINANCE_ADMIN);
    expect(rolesOf('creatorApplications')).not.toContain(RoleName.FINANCE_ADMIN);
    expect(rolesOf('games')).toContain(RoleName.GAME_OPERATOR);
  });
});
