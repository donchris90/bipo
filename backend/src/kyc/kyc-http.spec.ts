import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { KycAdminController, KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const roles = String(req.headers['x-test-roles'] ?? '').split(',').filter(Boolean);
    if (roles.length === 0) return false;
    req.user = { userId: 'me', roles };
    return true;
  }
}

describe('identity verification over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const kyc = {
    statusFor: jest.fn().mockResolvedValue({ verified: false, submission: null }),
    submit: jest.fn().mockResolvedValue({ status: 'PENDING' }),
    list: jest.fn().mockResolvedValue([]),
    document: jest.fn().mockResolvedValue({ contentType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) }),
    approve: jest.fn().mockResolvedValue({}),
    reject: jest.fn().mockResolvedValue({}),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [KycController, KycAdminController], providers: [{ provide: KycService, useValue: kyc }] })
      .overrideGuard(JwtAuthGuard).useClass(HeaderAuthGuard)
      .overrideGuard(UserThrottlerGuard).useValue({ canActivate: () => true })
      .compile();
    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  const call = (path: string, roles?: string, init: RequestInit = {}) => fetch(`${base}/api/v1/${path}`, { ...init, headers: { ...(roles ? { 'x-test-roles': roles } : {}), 'Content-Type': 'application/json' } });

  it('anyone signed in can read their own status and submit; nobody else can', async () => {
    expect((await call('kyc')).status).toBe(403);
    expect((await call('kyc', 'USER')).status).toBe(200);
    expect((await call('kyc', 'USER', { method: 'POST', body: JSON.stringify({ fullName: 'Ada Obi' }) })).status).toBe(201);
    expect(kyc.submit).toHaveBeenCalledWith('me', expect.objectContaining({ fullName: 'Ada Obi' }));
  });

  it('only trust-and-safety and super admins can list, view photos, approve or reject', async () => {
    for (const path of ['admin/kyc', 'admin/kyc/s1/image/SELFIE']) {
      expect((await call(path, 'USER,CREATOR')).status).toBe(403);
      expect((await call(path, 'USER,FINANCE_ADMIN')).status).toBe(403);
      expect((await call(path, 'USER,GAME_OPERATOR')).status).toBe(403);
      expect((await call(path, 'USER,TRUST_SAFETY_ADMIN')).status).toBe(200);
    }
    expect((await call('admin/kyc/s1/approve', 'USER,FINANCE_ADMIN', { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await call('admin/kyc/s1/approve', 'USER,SUPER_ADMIN', { method: 'POST', body: '{}' })).status).toBe(201);
    expect((await call('admin/kyc/s1/reject', 'USER,TRUST_SAFETY_ADMIN', { method: 'POST', body: JSON.stringify({ reason: 'blurry' }) })).status).toBe(201);
    expect(kyc.reject).toHaveBeenCalledWith('s1', 'me', ['USER', 'TRUST_SAFETY_ADMIN'], 'blurry');
  });

  it('serves a photo with headers that stop it being cached or sniffed', async () => {
    const res = await call('admin/kyc/s1/image/SELFIE', 'SUPER_ADMIN');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBe(3);
  });
});
