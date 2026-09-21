import { GamesReadinessService, canRunRounds, evaluateReadiness, type ReadinessInput } from './games-readiness';

const NOW = new Date('2026-09-21T12:00:00Z');
const base = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  gamesSwitchedOff: false,
  redis: { ok: true },
  countries: [{ countryCode: 'NG', countryName: 'Nigeria', active: true, gamesEnabled: true }],
  games: [{ code: 'CRASH', name: 'Crash', status: 'ACTIVE', minAge: 18 }],
  gameRegions: [{ gameCode: 'CRASH', countryCode: 'NG', enabled: true }],
  lastRoundAt: { CRASH: new Date(NOW.getTime() - 20_000) },
  hasOpenRound: { CRASH: true },
  now: NOW,
  ...over,
});
const keys = (r: any) => [...r.platform, ...r.games.flatMap((g: any) => [...g.problems, ...g.countries.flatMap((c: any) => c.problems)])].map((p) => p.key);

describe('evaluateReadiness — why nobody can play', () => {
  it('everything in place: the game is playable in that country', () => {
    const r = evaluateReadiness(base());
    expect(r.playable).toEqual([{ gameCode: 'CRASH', countryCode: 'NG' }]);
    expect(keys(r)).toEqual([]);
    expect(r.summary.message).toMatch(/Players can play 1 game/);
  });

  it('a fresh database (how the seed leaves it): game disabled, country games off, no game region', () => {
    const r = evaluateReadiness(
      base({
        games: [{ code: 'CRASH', name: 'Crash', status: 'DISABLED', minAge: 18 }],
        countries: [{ countryCode: 'NG', countryName: 'Nigeria', active: true, gamesEnabled: false }],
        gameRegions: [],
        hasOpenRound: {},
        lastRoundAt: {},
      }),
    );
    expect(r.playable).toEqual([]);
    expect(keys(r)).toEqual(expect.arrayContaining(['game_status', 'country_games', 'game_region']));
    expect(r.summary.message).toMatch(/Nobody can play/);
    // each admin-controlled problem carries the one-click fix
    const fixes = r.games[0].problems.concat(...r.games[0].countries.map((c) => c.problems)).map((p) => p.fix?.action);
    expect(fixes).toEqual(expect.arrayContaining(['set_game_status', 'enable_country_games', 'enable_game_region']));
  });

  it('Redis down: nobody can play even if everything else is set, and the reason is named', () => {
    const r = evaluateReadiness(base({ redis: { ok: false, error: 'timed out' } }));
    expect(r.playable).toEqual([]);
    expect(r.platform.map((p) => p.key)).toContain('redis');
    expect(r.platform[0].hint).toContain('REDIS_URL');
  });

  it('the platform-wide kill switch overrides everything', () => {
    const r = evaluateReadiness(base({ gamesSwitchedOff: true }));
    expect(r.playable).toEqual([]);
    expect(r.platform.map((p) => p.key)).toContain('flag');
  });

  it('an active game with no rounds is flagged (the scheduler is not running)', () => {
    const r = evaluateReadiness(base({ hasOpenRound: { CRASH: false }, lastRoundAt: { CRASH: new Date(NOW.getTime() - 10 * 60_000) } }));
    expect(keys(r)).toContain('rounds');
    expect(r.games[0].roundsRunning).toBe(false);
    // ...but a round created a minute ago is fine even if it just closed
    const ok = evaluateReadiness(base({ hasOpenRound: { CRASH: false }, lastRoundAt: { CRASH: new Date(NOW.getTime() - 60_000) } }));
    expect(keys(ok)).not.toContain('rounds');
  });

  it('only countries that are switched on are considered, and having none is reported', () => {
    const r = evaluateReadiness(base({ countries: [{ countryCode: 'GB', countryName: 'United Kingdom', active: false, gamesEnabled: false }] }));
    expect(r.platform.map((p) => p.key)).toContain('no_country');
    expect(r.games[0].countries).toEqual([]);
  });

  it('handles several games and countries independently', () => {
    const r = evaluateReadiness(
      base({
        countries: [
          { countryCode: 'NG', countryName: 'Nigeria', active: true, gamesEnabled: true },
          { countryCode: 'GH', countryName: 'Ghana', active: true, gamesEnabled: false },
        ],
        games: [
          { code: 'CRASH', name: 'Crash', status: 'ACTIVE', minAge: 18 },
          { code: 'SUM_DICE', name: 'Big Small', status: 'MAINTENANCE', minAge: 18 },
        ],
        gameRegions: [{ gameCode: 'CRASH', countryCode: 'NG', enabled: true }, { gameCode: 'SUM_DICE', countryCode: 'NG', enabled: true }],
        hasOpenRound: { CRASH: true, SUM_DICE: false },
        lastRoundAt: { CRASH: NOW, SUM_DICE: null },
      }),
    );
    expect(r.playable).toEqual([{ gameCode: 'CRASH', countryCode: 'NG' }]);
    expect(r.games.find((g) => g.code === 'CRASH')!.countries.find((c) => c.countryCode === 'GH')!.playable).toBe(false);
    expect(r.games.find((g) => g.code === 'SUM_DICE')!.problems.map((p) => p.key)).toContain('game_status');
  });
});

describe('a game the scheduler cannot run (the old Lucky Number)', () => {
  it('is called out with a one-click Disable, is never "playable", and does not also get a "no rounds" problem', () => {
    const r = evaluateReadiness(
      base({
        games: [
          { code: 'CRASH', name: 'Crash', status: 'ACTIVE', minAge: 18, supported: true },
          { code: 'LUCKY_NUMBER', name: 'Lucky Number', status: 'ACTIVE', minAge: 18, supported: false },
        ],
        gameRegions: [{ gameCode: 'CRASH', countryCode: 'NG', enabled: true }, { gameCode: 'LUCKY_NUMBER', countryCode: 'NG', enabled: true }],
        hasOpenRound: { CRASH: true, LUCKY_NUMBER: false },
        lastRoundAt: { CRASH: NOW, LUCKY_NUMBER: null },
      }),
    );
    const lucky = r.games.find((g) => g.code === 'LUCKY_NUMBER')!;
    expect(lucky.problems.map((p) => p.key)).toEqual(['unsupported']);
    expect(lucky.problems[0].fix).toEqual({ action: 'disable_game', gameCode: 'LUCKY_NUMBER' });
    expect(r.playable).toEqual([{ gameCode: 'CRASH', countryCode: 'NG' }]);
  });

  it('a disabled unsupported game raises nothing (nothing is wrong with a game that is off)', () => {
    const r = evaluateReadiness(base({ games: [{ code: 'LUCKY_NUMBER', name: 'Lucky Number', status: 'DISABLED', minAge: 18, supported: false }], hasOpenRound: {}, lastRoundAt: {} }));
    expect(r.games[0].problems).toEqual([]);
  });

  it('knows which rules the scheduler can run', () => {
    expect(canRunRounds({ houseEdge: 0.03, growthRate: 0.13 })).toBe(true);
    expect(canRunRounds({ payoutMultiplier: 9, diceCount: 3, diceSides: 10 })).toBe(true);
    expect(canRunRounds({ payoutMultiplier: 20 })).toBe(false);
    expect(canRunRounds(null)).toBe(false);
  });
});

describe('an empty database', () => {
  it('says no games exist and how to create them', () => {
    const r = evaluateReadiness(base({ games: [], gameRegions: [], lastRoundAt: {}, hasOpenRound: {} }));
    expect(r.platform.map((p) => p.title).join(' ')).toMatch(/No games exist/);
    expect(r.platform.map((p) => p.hint).join(' ')).toContain('npm run seed');
  });
});

describe('GamesReadinessService.redis', () => {
  const svc = (queue: any) => new GamesReadinessService({} as any, {} as any, queue);
  it('reports connected when the queue answers a ping', async () => {
    expect(await svc({ client: Promise.resolve({ ping: async () => 'PONG' }) }).redis()).toEqual({ ok: true });
  });
  it('reports not connected, with the reason, when it cannot', async () => {
    const r = await svc({ client: Promise.resolve({ ping: async () => { throw new Error('ECONNREFUSED 127.0.0.1:6379'); } }) }).redis();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
