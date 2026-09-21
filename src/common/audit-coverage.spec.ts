import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from './decorators/roles.decorator';
const SRC = join(__dirname, '..');
function walk(d: string): string[] { return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : []; }); }
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
export const AUDIT = /audit[A-Za-z]*\.record\(|\.audit\.record\(|logModeration|moderationAction\.create/;

// Phase 6: does every admin/privileged WRITE action leave an audit-log entry? This follows
// each write route into the service method it calls and looks for an audit record there.
// (A heuristic — it looks one call deep — so it can miss an audit written further down, but
// it can never claim an audit that is not in the code it followed.)
function scan() {
  const results: { route: string; audited: boolean; via: string }[] = [];
  for (const file of walk(SRC)) {
    if (!/@Controller\(/.test(readFileSync(file, 'utf8'))) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const cls of Object.values(mod) as any[]) {
      if (typeof cls !== 'function' || Reflect.getMetadata(PATH_METADATA, cls) === undefined) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls));
      const paramNames = (/constructor\(([^)]*)\)/.exec(cls.toString())?.[1] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
      const types: any[] = Reflect.getMetadata('design:paramtypes', cls) ?? [];
      const svcByName: Record<string, any> = {};
      paramNames.forEach((n: string, i: number) => (svcByName[n] = types[i]));
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const h = cls.prototype[name];
        if (name === 'constructor' || typeof h !== 'function') continue;
        const m = Reflect.getMetadata(METHOD_METADATA, h);
        if (m === undefined || m === 0) continue; // writes only
        const roles = Reflect.getMetadata(ROLES_KEY, h) ?? Reflect.getMetadata(ROLES_KEY, cls) ?? [];
        const path = `/${base}/${Reflect.getMetadata(PATH_METADATA, h) ?? ''}`.replace(/\/+/g, '/');
        if (!/admin/.test(path) && roles.length === 0) continue;
        const text = h.toString();
        let audited = AUDIT.test(text);
        const via: string[] = [];
        for (const mm of text.matchAll(/this\.(\w+)\.(\w+)\(/g)) {
          const svc = svcByName[mm[1]];
          const fn = svc?.prototype?.[mm[2]];
          if (typeof fn === 'function') {
            via.push(`${svc.name}.${mm[2]}`);
            if (AUDIT.test(fn.toString())) audited = true;
          }
        }
        results.push({ route: `${METHODS[m]} ${path}`, audited, via: via.join(', ') });
      }
    }
  }
  return results;
}

// Manual game-round operations (open, lock, settle, create) move players' money and are done by
// hand by a game operator, yet leave no audit entry. Listed here so the gap stays visible.
const KNOWN_UNAUDITED = ['POST /api/v1/admin/games/rounds', 'POST /api/v1/admin/games/rounds/:roundId/lock', 'POST /api/v1/admin/games/rounds/:roundId/open', 'POST /api/v1/admin/games/rounds/:roundId/settle'];

describe('audit logging of admin actions', () => {
  const results = scan();
  it('found the admin write routes', () => expect(results.length).toBeGreaterThan(25));

  it('every admin write action records who did it, except the documented gap', () => {
    const missing = results.filter((r) => !r.audited).map((r) => r.route).filter((r) => !KNOWN_UNAUDITED.includes(r));
    expect(missing).toEqual([]);
  });

  it.failing('DEFECT: manual game-round operations (including settling a round and paying players) are audited', () => {
    const missing = results.filter((r) => !r.audited).map((r) => r.route);
    expect(missing).toEqual([]);
  });
});
