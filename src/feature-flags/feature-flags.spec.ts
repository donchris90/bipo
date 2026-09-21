import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { FeatureFlagsService, KNOWN_FLAGS } from './feature-flags.service';

function service() {
  const flags = new Map<string, any>();
  const prisma: any = {
    featureFlag: {
      findUnique: async ({ where: { key } }: any) => flags.get(key) ?? null,
      findMany: async () => [...flags.values()].sort((a, b) => a.key.localeCompare(b.key)),
      upsert: async ({ where: { key }, update, create }: any) => { const row = flags.has(key) ? Object.assign(flags.get(key), update) : { ...create }; flags.set(key, row); return row; },
    },
  };
  const audit: any = { record: jest.fn() };
  return { svc: new FeatureFlagsService(prisma, audit), audit };
}

describe('feature flags (the emergency kill switches)', () => {
  it('a flag that was never set is OFF; turning it on is remembered, and off again works', async () => {
    const { svc } = service();
    expect(await svc.isEnabled('DISABLE_WITHDRAWALS')).toBe(false);
    await svc.set('DISABLE_WITHDRAWALS', true, 'admin1', ['SUPER_ADMIN'] as any);
    expect(await svc.isEnabled('DISABLE_WITHDRAWALS')).toBe(true);
    await svc.set('DISABLE_WITHDRAWALS', false, 'admin1', ['SUPER_ADMIN'] as any);
    expect(await svc.isEnabled('DISABLE_WITHDRAWALS')).toBe(false);
  });

  it('every change is audited with who, which flag and the new value', async () => {
    const { svc, audit } = service();
    await svc.set('DISABLE_PAYMENTS', true, 'admin1', ['SUPER_ADMIN'] as any);
    expect(audit.record).toHaveBeenCalledWith({ actorId: 'admin1', actorRole: 'SUPER_ADMIN', action: 'feature_flag.set', targetType: 'feature_flag', targetId: 'DISABLE_PAYMENTS', metadata: { enabled: true } });
  });

  it('flags are independent of each other', async () => {
    const { svc } = service();
    await svc.set('DISABLE_GAMES', true, 'a', [] as any);
    expect(await svc.isEnabled('DISABLE_GAMES')).toBe(true);
    expect(await svc.isEnabled('DISABLE_GIFTS')).toBe(false);
  });
});

// A kill switch that nothing reads is worse than none: an admin flips it in an emergency and
// believes the money has stopped. This checks that each documented switch is really consulted
// by some code outside the flag service itself.
function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : []; });
}
const sources = walk(join(__dirname, '..')).filter((f) => !f.endsWith('feature-flags.service.ts') && !f.endsWith('games-readiness.ts')).map((f) => readFileSync(f, 'utf8'));
const consulted = (flag: string) => sources.some((s) => new RegExp(`isEnabled\\(\\s*['"]${flag}['"]`).test(s));

describe('every kill switch is actually wired to what it claims to stop', () => {
  it('the list of switches is the documented six', () => {
    expect([...KNOWN_FLAGS]).toEqual(['DISABLE_PAYMENTS', 'DISABLE_WITHDRAWALS', 'DISABLE_GAMES', 'DISABLE_GIFTS', 'DISABLE_NEW_REGISTRATION', 'DISABLE_LIVE']);
  });

  it('DISABLE_GAMES and DISABLE_LIVE stop the games and going live', () => {
    expect(consulted('DISABLE_GAMES')).toBe(true);
    expect(consulted('DISABLE_LIVE')).toBe(true);
  });

  it.failing('DEFECT: DISABLE_PAYMENTS stops new coin purchases (nothing reads it today)', () => expect(consulted('DISABLE_PAYMENTS')).toBe(true));
  it.failing('DEFECT: DISABLE_WITHDRAWALS stops withdrawal requests and payouts (nothing reads it today)', () => expect(consulted('DISABLE_WITHDRAWALS')).toBe(true));
  it.failing('DEFECT: DISABLE_GIFTS stops gift sending (nothing reads it today)', () => expect(consulted('DISABLE_GIFTS')).toBe(true));
  it.failing('DEFECT: DISABLE_NEW_REGISTRATION stops sign-ups (nothing reads it today)', () => expect(consulted('DISABLE_NEW_REGISTRATION')).toBe(true));
});
