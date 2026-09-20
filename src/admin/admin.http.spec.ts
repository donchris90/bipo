import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutConfigService } from '../payouts/payout-config.service';

// Stands in for JwtAuthGuard only: the caller's roles come from a header, so the
// REAL RolesGuard, routing, query parsing and service run over real HTTP.
class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const roles = String(req.headers['x-test-roles'] ?? '').split(',').filter(Boolean);
    if (roles.length === 0) return false;
    req.user = { userId: 'admin-1', roles, countryCode: 'NG' };
    return true;
  }
}

describe('admin API over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const prisma: any = {
    user: { count: jest.fn().mockResolvedValue(5), findMany: jest.fn().mockResolvedValue([]) },
    liveSession: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([]) },
    partyRoom: { count: jest.fn().mockResolvedValue(0) },
    creatorApplication: { count: jest.fn().mockResolvedValue(0) },
    withdrawalRequest: { count: jest.fn().mockResolvedValue(0), aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
    agency: { count: jest.fn().mockResolvedValue(0) },
    kycSubmission: { count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([]) },
    coinPurchase: { groupBy: jest.fn().mockResolvedValue([]) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const payoutConfig = {
    listForAdmin: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(async (_c: string, body: any) => ({ ...body })),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: PayoutConfigService, useValue: payoutConfig },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  const get = (path: string, roles?: string) => fetch(`${base}/api/v1/admin/${path}`, { headers: roles ? { 'x-test-roles': roles } : {} });

  it('rejects an unauthenticated caller', async () => {
    expect((await get('overview')).status).toBe(403);
  });

  it('rejects a signed-in account that has no admin role', async () => {
    expect((await get('overview', 'USER,CREATOR')).status).toBe(403);
    expect((await get('users', 'USER')).status).toBe(403);
  });

  it('lets each admin role reach its own data and only its own', async () => {
    expect((await get('withdrawals', 'USER,FINANCE_ADMIN')).status).toBe(200);
    expect((await get('withdrawals', 'USER,TRUST_SAFETY_ADMIN')).status).toBe(403);
    expect((await get('audit-log', 'USER,TRUST_SAFETY_ADMIN')).status).toBe(200);
    expect((await get('audit-log', 'USER,FINANCE_ADMIN')).status).toBe(403);
    expect((await get('overview', 'USER,GAME_OPERATOR')).status).toBe(200);
  });

  it('returns the overview shape, with money only for finance', async () => {
    const fin = await (await get('overview', 'FINANCE_ADMIN')).json();
    expect(fin.users.total).toBe(5);
    expect(fin.finance).not.toBeNull();
    const ts = await (await get('overview', 'TRUST_SAFETY_ADMIN')).json();
    expect(ts.finance).toBeNull();
  });

  it('refuses an unknown status value instead of sending it to the database', async () => {
    const res = await get('withdrawals?status=%27%3B%20DROP%20TABLE', 'FINANCE_ADMIN');
    expect(res.status).toBe(400);
  });

  it('caps the page size', async () => {
    await get('users?limit=100000', 'SUPER_ADMIN');
    expect(prisma.user.findMany.mock.calls.at(-1)[0].take).toBe(100);
  });

  it('payout settings can only be read or changed by finance and super admins', async () => {
    expect((await get('payout-config', 'USER,FINANCE_ADMIN')).status).toBe(200);
    expect((await get('payout-config', 'USER,TRUST_SAFETY_ADMIN')).status).toBe(403);
    expect((await get('payout-config', 'USER,GAME_OPERATOR')).status).toBe(403);

    const put = (roles: string) =>
      fetch(`${base}/api/v1/admin/payout-config/NG`, { method: 'PUT', headers: { 'x-test-roles': roles, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    expect((await put('USER,TRUST_SAFETY_ADMIN')).status).toBe(403);
    expect((await put('USER,FINANCE_ADMIN')).status).toBe(200);
    expect(payoutConfig.upsert).toHaveBeenCalledWith('NG', { enabled: true }, 'admin-1', ['USER', 'FINANCE_ADMIN']);
  });
});
