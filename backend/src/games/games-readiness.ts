import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { GAME_QUEUE } from '../queue/queue.module';

// "Why can't people play?" A game only works when SEVERAL things are true at once,
// and any one of them missing looks the same to a player ("not active"). This
// checks all of them and says which is missing and how to fix it.

export interface Problem {
  key: 'flag' | 'redis' | 'game_status' | 'unsupported' | 'no_country' | 'country_games' | 'game_region' | 'rounds';
  title: string;
  hint: string;
  // What the admin page can do about it with one click (only for things the admin controls).
  fix?: { action: 'set_game_status' | 'disable_game' | 'enable_country_games' | 'enable_game_region'; gameCode?: string; countryCode?: string };
}

export interface ReadinessInput {
  gamesSwitchedOff: boolean; // the DISABLE_GAMES kill switch
  redis: { ok: boolean; error?: string };
  countries: { countryCode: string; countryName: string; active: boolean; gamesEnabled: boolean }[];
  // `supported` = the scheduler can run rounds for it (a dice game or a crash game).
  games: { code: string; name: string; status: string; minAge: number; supported?: boolean }[];
  gameRegions: { gameCode: string; countryCode: string; enabled: boolean }[];
  lastRoundAt: Record<string, Date | null>;
  hasOpenRound: Record<string, boolean>;
  now: Date;
}

const ROUNDS_STALE_MS = 3 * 60 * 1000;

// Mirrors what the round scheduler can create rounds for: a dice game (diceCount + diceSides)
// or a crash game (houseEdge + growthRate). Anything else would take bets that can never win.
export function canRunRounds(rulesJson: unknown): boolean {
  const r = (rulesJson ?? {}) as { diceCount?: unknown; diceSides?: unknown; houseEdge?: unknown; growthRate?: unknown; turnSeconds?: unknown; prizeFirstPercent?: unknown };
  return (!!r.diceCount && !!r.diceSides) || (typeof r.houseEdge === 'number' && typeof r.growthRate === 'number') || (typeof r.turnSeconds === 'number' && typeof r.prizeFirstPercent === 'number');
}

export function evaluateReadiness(i: ReadinessInput) {
  const platform: Problem[] = [];
  if (i.gamesSwitchedOff) {
    platform.push({ key: 'flag', title: 'Games are switched off for everyone', hint: 'The DISABLE_GAMES switch is on. Turn it off under Settings → Feature flags.' });
  }
  if (!i.redis.ok) {
    platform.push({
      key: 'redis',
      title: 'The game engine (Redis) is not connected',
      hint: `Rounds are created and settled through Redis. Create a Redis / Key Value instance, set REDIS_URL on the server, and redeploy.${i.redis.error ? ` (${i.redis.error})` : ''}`,
    });
  }

  const liveCountries = i.countries.filter((c) => c.active);
  const playable: { gameCode: string; countryCode: string }[] = [];

  const games = i.games.map((g) => {
    const problems: Problem[] = [];
    const isActive = g.status === 'ACTIVE';
    const unsupported = g.supported === false;
    if (isActive && unsupported) {
      problems.push({
        key: 'unsupported',
        title: `${g.name} is Active but cannot run`,
        hint: 'This game is missing its supported game-engine rules. Set it to Disabled until its rules are configured.',
        fix: { action: 'disable_game', gameCode: g.code },
      });
    } else if (!isActive && !unsupported) {
      problems.push({
        key: 'game_status',
        title: `${g.name} is ${g.status.toLowerCase()}`,
        hint: 'Set the game to Active on the Games page.',
        fix: { action: 'set_game_status', gameCode: g.code },
      });
    }

    const countries = liveCountries.map((c) => {
      const cp: Problem[] = [];
      if (!c.gamesEnabled) {
        cp.push({ key: 'country_games', title: `Games are off in ${c.countryName}`, hint: 'Turn on "Games" for this country under Settings → Regions.', fix: { action: 'enable_country_games', countryCode: c.countryCode } });
      }
      const gr = i.gameRegions.find((r) => r.gameCode === g.code && r.countryCode === c.countryCode);
      if (!gr?.enabled) {
        cp.push({ key: 'game_region', title: `${g.name} is not switched on in ${c.countryName}`, hint: 'Turn the country on inside this game (Configure → Where it can be played).', fix: { action: 'enable_game_region', gameCode: g.code, countryCode: c.countryCode } });
      }
      const ok = isActive && !unsupported && cp.length === 0 && !i.gamesSwitchedOff && i.redis.ok;
      if (ok) playable.push({ gameCode: g.code, countryCode: c.countryCode });
      return { countryCode: c.countryCode, countryName: c.countryName, playable: ok, problems: cp };
    });

    // Ludo uses a persistent match room instead of the scheduler's timed rounds.
    const realTimeMatch = g.code === 'LUDO';
    let roundsRunning: boolean | null = realTimeMatch ? null : null;
    if (isActive && !unsupported && !realTimeMatch) {
      const last = i.lastRoundAt[g.code];
      roundsRunning = !!i.hasOpenRound[g.code] || (!!last && i.now.getTime() - last.getTime() < ROUNDS_STALE_MS);
      if (!roundsRunning && i.redis.ok) {
        problems.push({ key: 'rounds', title: 'No rounds are being created', hint: 'The game is active but no round has started in the last few minutes. Check the server log for "Round scheduler" errors.' });
      }
    }
    return { code: g.code, name: g.name, status: g.status, problems, countries, roundsRunning };
  });

  if (i.games.length === 0) {
    platform.push({ key: 'no_country', title: 'No games exist in this database', hint: 'The three games are created by the seed. Run `npm run seed` once against this database (set SEED_ADMIN_EMAIL to your own admin email first so it does not add a default admin).' });
  }
  if (liveCountries.length === 0) {
    platform.push({ key: 'no_country', title: 'No country is switched on', hint: 'Set a country to Active under Settings → Regions (for example Nigeria).' });
  }

  const message =
    playable.length > 0
      ? `Players can play ${new Set(playable.map((p) => p.gameCode)).size} game(s) in ${new Set(playable.map((p) => p.countryCode)).size} country(ies).`
      : 'Nobody can play any game right now. Fix the items below.';
  return { platform, games, playable, summary: { playableCount: playable.length, message } };
}

@Injectable()
export class GamesReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagsService,
    @Inject(GAME_QUEUE) private readonly queue: Queue,
  ) {}

  async redis(): Promise<{ ok: boolean; error?: string }> {
    const timeout = <T>(ms: number) => new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms));
    try {
      const client: any = await Promise.race([(this.queue as any).client, timeout<never>(2500)]);
      const pong = await Promise.race([client.ping(), timeout<never>(2500)]);
      return { ok: pong === 'PONG' };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
    }
  }

  async report(now = new Date()) {
    const [flag, redis, countries, games, gameRegions] = await Promise.all([
      this.featureFlags.isEnabled('DISABLE_GAMES'),
      this.redis(),
      this.prisma.regionalConfig.findMany({ select: { countryCode: true, countryName: true, active: true, gamesEnabled: true }, orderBy: { countryCode: 'asc' } }),
      this.prisma.gameDefinition.findMany({ select: { code: true, name: true, status: true, minAge: true, rulesJson: true }, orderBy: { code: 'asc' } }),
      this.prisma.gameRegionConfig.findMany({ select: { gameCode: true, countryCode: true, enabled: true } }),
    ]);
    const lastRoundAt: Record<string, Date | null> = {};
    const hasOpenRound: Record<string, boolean> = {};
    await Promise.all(
      games.map(async (g) => {
        const [last, open] = await Promise.all([
          this.prisma.gameRound.findFirst({ where: { gameCode: g.code }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
          this.prisma.gameRound.findFirst({ where: { gameCode: g.code, status: { in: ['SCHEDULED', 'OPEN', 'LOCKED', 'RESOLVING'] } }, select: { id: true } }),
        ]);
        lastRoundAt[g.code] = last?.createdAt ?? null;
        hasOpenRound[g.code] = !!open;
      }),
    );
    const withSupport = games.map(({ rulesJson, ...g }) => ({ ...g, supported: canRunRounds(rulesJson) }));
    return evaluateReadiness({ gamesSwitchedOff: !!flag, redis, countries, games: withSupport, gameRegions, lastRoundAt, hasOpenRound, now });
  }
}
