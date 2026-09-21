import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RoleName } from '@prisma/client';
import { RolesGuard } from './guards/roles.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ROLES_KEY } from './decorators/roles.decorator';

// Phase 6: who can call what. This reads the ACTUAL decorators on every controller in the
// app, then runs the ACTUAL RolesGuard against every route with: no user, a plain user, and
// every role. So it answers "can unauthorised people reach any admin endpoint?" for every
// endpoint at once, and keeps answering it when someone adds a route later.

const SRC = join(__dirname, '..');
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

interface Route { file: string; controller: string; method: string; path: string; guards: string[]; roles: RoleName[]; handler: Function; cls: Function }

function collect(): Route[] {
  const routes: Route[] = [];
  for (const file of walk(SRC)) {
    if (!/@Controller\(/.test(readFileSync(file, 'utf8'))) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const cls of Object.values(mod) as any[]) {
      if (typeof cls !== 'function' || Reflect.getMetadata(PATH_METADATA, cls) === undefined) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      const classGuards: any[] = Reflect.getMetadata('__guards__', cls) ?? [];
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const m = Reflect.getMetadata(METHOD_METADATA, handler);
        if (m === undefined) continue;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const guards = [...classGuards, ...((Reflect.getMetadata('__guards__', handler) as any[]) ?? [])].map((g) => g?.name ?? String(g));
        const roles = (Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, cls) ?? []) as RoleName[];
        routes.push({ file: file.replace(SRC + '/', ''), controller: cls.name, method: METHODS[m] ?? String(m), path: `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/'), guards, roles, handler, cls });
      }
    }
  }
  return routes;
}

const ctx = (route: Route, user: any): ExecutionContext => ({ getHandler: () => route.handler, getClass: () => route.cls, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
const allowedBy = (route: Route, user: any) => {
  try { return new RolesGuard(new Reflector()).canActivate(ctx(route, user)); } catch (e) { if (e instanceof ForbiddenException) return false; throw e; }
};

const routes = collect();
const adminRoutes = routes.filter((r) => /(^|\/)admin(\/|$)/.test(r.path));
const ALL_ROLES = Object.values(RoleName) as RoleName[];
const ORDINARY: RoleName[] = ['USER', 'CREATOR'].filter((r) => ALL_ROLES.includes(r as RoleName)) as RoleName[];

describe('route security — every controller in the app', () => {
  it('found the controllers (guards against this test silently checking nothing)', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(adminRoutes.length).toBeGreaterThan(40);
  });

  it('EVERY admin route requires a login, the role guard AND at least one named role', () => {
    const bad = adminRoutes.filter((r) => !(r.guards.includes(JwtAuthGuard.name) && r.guards.includes(RolesGuard.name) && r.roles.length > 0));
    expect(bad.map((r) => `${r.method} ${r.path} (${r.controller})`)).toEqual([]);
  });

  it('no route names roles but forgets the role guard (which would silently ignore the roles)', () => {
    const bad = routes.filter((r) => r.roles.length > 0 && !r.guards.includes(RolesGuard.name));
    expect(bad.map((r) => `${r.method} ${r.path} (${r.controller})`)).toEqual([]);
  });

  it('with no user, or an ordinary user (USER / CREATOR), NO admin route lets them through', () => {
    for (const r of adminRoutes) {
      expect([r.method, r.path, allowedBy(r, undefined)]).toEqual([r.method, r.path, false]);
      expect([r.method, r.path, allowedBy(r, { roles: [] })]).toEqual([r.method, r.path, false]);
      for (const role of ORDINARY) expect([r.method, r.path, role, allowedBy(r, { roles: [role] })]).toEqual([r.method, r.path, role, false]);
    }
  });

  it('every admin route lets in exactly the roles it names, and nobody else', () => {
    for (const r of adminRoutes) {
      for (const role of ALL_ROLES) {
        const want = r.roles.includes(role);
        expect([r.method, r.path, role, allowedBy(r, { roles: [role] })]).toEqual([r.method, r.path, role, want]);
      }
    }
  });

  it('the only routes with no login required are the ones that are meant to be public', () => {
    const open = routes.filter((r) => !r.guards.includes(JwtAuthGuard.name)).map((r) => `${r.method} ${r.path}`);
    const allowed = [/^POST \/api\/v1\/webhooks\//, /^POST \/api\/v1\/auth\/(register|login|refresh|logout|password)/, /^(GET|POST) \/api\/v1\/auth\//, /^GET \/(api\/v1\/)?(health|ready|)\/?$/, /^GET \/api\/v1\/health/, /^GET \/api\/v1\/storage\/files\//, /^GET \/api\/v1\/regions/, /^POST \/api\/v1\/auth/];
    const unexpected = open.filter((o) => !allowed.some((a) => a.test(o)));
    expect(unexpected).toEqual([]);
  });

  it('routes whose names suggest money or account power are not open to any logged-in user', () => {
    const powerful = routes.filter((r) => /(approve|reject|resolve|refund|chargeback|grant|suspend|ban|adjust|payout|reconcil|impersonate)/i.test(r.path) && r.roles.length === 0);
    // rooms/party controls (approve a seat request, ban from a room) are the ROOM HOST's power, checked inside the service, not an admin role
    const nonRoom = powerful.filter((r) => !/(\/rooms\/|\/live\/|\/pk\/|\/social\/|\/c2c\/|\/creators\/withdrawals|\/payout-account|\/payouts\/(account|banks|resolve|config\/me)|\/payout\/|\/webhooks\/|\/messages\/)/.test(r.path));
    expect(nonRoom.map((r) => `${r.method} ${r.path} (${r.controller})`)).toEqual([]);
  });

  if (process.env.WRITE_MATRIX) {
    it('writes the permission matrix', () => {
      const lines = ['# Admin permission matrix', '', 'Generated by running the real guards against every admin route. ✓ = allowed, blank = refused (403). Not logged in = always refused (401).', '', `| Route | ${ALL_ROLES.join(' | ')} |`, `|---|${ALL_ROLES.map(() => '---').join('|')}|`];
      for (const r of adminRoutes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
        lines.push(`| \`${r.method} ${r.path}\` | ${ALL_ROLES.map((role) => (allowedBy(r, { roles: [role] }) ? '✓' : '')).join(' | ')} |`);
      }
      lines.push('', '## Routes that need no login', '', ...routes.filter((r) => !r.guards.includes(JwtAuthGuard.name)).map((r) => `- \`${r.method} ${r.path}\` (${r.controller})`));
      lines.push('', '## Non-admin routes that require a role', '', ...routes.filter((r) => !adminRoutes.includes(r) && r.roles.length > 0).map((r) => `- \`${r.method} ${r.path}\` → ${r.roles.join(', ')}`));
      writeFileSync(process.env.WRITE_MATRIX as string, lines.join('\n') + '\n');
    });
  }
});
