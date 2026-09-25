import { CrashService } from './crash.service';
import { crashTimeSeconds, currentMultiplier } from './crash-rules';

const GROWTH = Math.log(2) / 5;
const LOCK_AT = new Date('2026-09-21T12:00:00.000Z');

function build(round: any, rules: any = { houseEdge: 0.03, growthRate: GROWTH }) {
  const prisma: any = {
    gameRound: { findUniqueOrThrow: jest.fn().mockResolvedValue(round) },
    gameDefinition: { findUnique: jest.fn().mockResolvedValue({ rulesJson: rules }) },
  };
  return new CrashService(prisma, {} as any, {} as any);
}
const locked = (crashPoint: number, extra: any = {}) => ({ id: 'r1', gameCode: 'CRASH', status: 'LOCKED', lockAt: LOCK_AT, hiddenState: { crashPoint }, ...extra });

describe('CrashService.getStatus — what the app needs to draw a smooth flight', () => {
  it('while flying it gives the curve (growth rate and seconds elapsed) so the app can move smoothly between checks', async () => {
    const svc = build(locked(50));
    const s = await svc.getStatus('r1', LOCK_AT.getTime() + 3000);
    expect(s).toEqual({ status: 'LIVE', multiplier: currentMultiplier(3, GROWTH), growthRate: GROWTH, elapsedMs: 3000, serverNow: LOCK_AT.getTime() + 3000 });
  });

  it('the curve the app is given reproduces the server multiplier exactly at any moment', async () => {
    const svc = build(locked(500));
    for (const ms of [200, 1000, 2500, 7000, 20000]) {
      const s: any = await svc.getStatus('r1', LOCK_AT.getTime() + ms);
      expect(Math.floor(Math.exp(s.growthRate * (s.elapsedMs / 1000)) * 100) / 100).toBe(s.multiplier);
    }
  });

  it('never gives away when it will crash: nothing in a LIVE answer depends on the crash point', async () => {
    const a: any = await build(locked(1.5)).getStatus('r1', LOCK_AT.getTime() + 300);
    const b: any = await build(locked(900)).getStatus('r1', LOCK_AT.getTime() + 300);
    expect(a).toEqual(b);
  });

  it('once the crash time has passed it says CRASHED with no value (the point is only official after settlement)', async () => {
    const crashSecs = crashTimeSeconds(2, GROWTH);
    const s = await build(locked(2)).getStatus('r1', LOCK_AT.getTime() + (crashSecs + 0.1) * 1000);
    expect(s).toEqual({ status: 'CRASHED', multiplier: 2, serverNow: LOCK_AT.getTime() + (crashSecs + 0.1) * 1000 });
  });

  it('a settled round reports the official crash point', async () => {
    const s = await build({ id: 'r1', gameCode: 'CRASH', status: 'SETTLED', result: { crashPoint: 3.21 } }).getStatus('r1', 5);
    expect(s).toMatchObject({ status: 'CRASHED', multiplier: 3.21 });
  });

  it('an open round is 1.00x with just the clock', async () => {
    const s = await build({ id: 'r1', gameCode: 'CRASH', status: 'OPEN' }).getStatus('r1', 7);
    expect(s).toEqual({ status: 'OPEN', multiplier: 1, serverNow: 7 });
  });
});
