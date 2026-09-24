import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoundService } from './round.service';
import { SettlementService } from './settlement.service';
import { CrashService } from './crash.service';
import { crashTimeSeconds } from './crash-rules';
import { ABANDON_AFTER_MS, planRoundRecovery, RecoveryAction } from './round-recovery';

// Nothing in this codebase ever created a second round. RoundService.createRound
// is only ever called from GamesController's admin POST /games/rounds endpoint
// (games.controller.ts) — a human had to manually POST a new round every single
// time the previous one settled. In practice that means every game (Crash
// included) sits with zero in-flight rounds almost all the time: GameRound
// table empty for that gameCode, GET /games/:code/rounds returns [], the
// client has no currentRoundId, and CrashScreen just shows its "!currentRoundId"
// loading spinner forever — never opens the betting UI, never shows a live
// multiplier. This service is the missing "keep it running" loop.
//
// It does not decide which games are live — that's still entirely
// GameDefinition.status (ACTIVE/DISABLED/MAINTENANCE) and
// GameRegionConfig, both untouched here. A DISABLED game simply never gets
// a round created for it, exactly as before; flipping a game live is still
// a deliberate GameAdminService.setStatus call.
@Injectable()
export class RoundSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoundSchedulerService.name);
  private createTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  // Per-gameCode in-flight guard so two overlapping poll ticks (or a tick
  // that's still awaiting a slow createRound) can't both decide "nothing
  // exists yet" and each create a round for the same game. Stores the start
  // time so a step that hangs cannot block a game forever.
  private readonly creating = new Map<string, number>();
  // Loop guards (same idea): skip a run if the previous one is still going,
  // unless it has been going implausibly long.
  private readonly running: Record<'create' | 'sweep', number> = { create: 0, sweep: 0 };
  // Rounds already reported as unrecoverable, so the log is not spammed every second.
  private readonly reported = new Set<string>();
  private catalog?: { at: number; games: Map<string, { isCrash: boolean; growthRate: number }> };
  private lastNoActiveWarn = 0;

  private static readonly STEP_TIMEOUT_MS = 30_000;
  private static readonly SWEEP_INTERVAL_MS = 1000;

  // How long a fresh round stays OPEN for entries before it locks —
  // matches the reference UI copy this project was built against ("Fast
  // 15s Betting Round" for Lucky Number/Sum Dice; Crash uses a shorter
  // betting window since its own "round" is mostly the live climb that
  // follows). Read from rulesJson.openSeconds first so an operator can
  // retune a specific game without a code change; these are just the
  // fallback when that isn't set.
  private static readonly DEFAULT_OPEN_SECONDS: Record<string, number> = {
    CRASH: 8,
    SUM_DICE: 30,
    LUCKY_NUMBER: 15,
  };
  // Minimum stake / entry price for a freshly-created round, same
  // fallback pattern — see entryPrice's doc comment in round.service.ts
  // for why this is a minimum, not a fixed price.
  private static readonly DEFAULT_ENTRY_PRICE: Record<string, number> = {
    CRASH: 10,
    SUM_DICE: 10,
    LUCKY_NUMBER: 10,
  };
  // Idle gap between one round settling and the next opening — gives the
  // client a moment to show the settled result (and matches the "NEXT
  // LAUNCH" countdown CrashScreen already renders) instead of instantly
  // replacing it.
  private static readonly GAP_SECONDS = 4;
  private static readonly POLL_INTERVAL_MS = 3000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rounds: RoundService,
    private readonly settlement: SettlementService,
    private readonly crash: CrashService,
  ) {}

  onModuleInit() {
    this.logger.log('Round scheduler started: rounds are created, opened, locked and settled from the database, with or without Redis.');
    this.createTimer = setInterval(() => void this.runGuarded('create', () => this.tick()), RoundSchedulerService.POLL_INTERVAL_MS);
    this.sweepTimer = setInterval(() => void this.runGuarded('sweep', () => this.sweep()), RoundSchedulerService.SWEEP_INTERVAL_MS);
    // Run once immediately too, rather than waiting out the first interval
    // after every deploy/restart. The sweep goes first so anything left over
    // from before the restart is repaired before a new round is created.
    void this.runGuarded('sweep', () => this.sweep()).then(() => this.runGuarded('create', () => this.tick()));
  }

  onModuleDestroy() {
    if (this.createTimer) clearInterval(this.createTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async runGuarded(name: 'create' | 'sweep', fn: () => Promise<void>) {
    const startedAt = this.running[name];
    if (startedAt && Date.now() - startedAt < RoundSchedulerService.STEP_TIMEOUT_MS) return;
    this.running[name] = Date.now();
    try {
      await fn();
    } catch (err: any) {
      this.logger.error(`Round scheduler ${name} failed: ${err?.message ?? err}`);
    } finally {
      this.running[name] = 0;
    }
  }

  private async tick() {
    const games = await this.prisma.gameDefinition.findMany({ where: { status: 'ACTIVE' } });
    if (games.length === 0 && Date.now() - this.lastNoActiveWarn > 60_000) {
      this.lastNoActiveWarn = Date.now();
      this.logger.warn('No game is ACTIVE, so no rounds are being created. Set a game to Active in the admin panel.');
    }
    await Promise.all(games.filter((game) => game.code !== 'LUDO').map((game) => this.ensureRound(game.code, game.version)));
  }

  // Every game we know about, with just what recovery needs. Cached briefly:
  // this runs every second and the definitions almost never change. Includes
  // paused/disabled games — a round already in flight should still finish.
  private async gameCatalog() {
    if (this.catalog && Date.now() - this.catalog.at < 30_000) return this.catalog.games;
    const defs = await this.prisma.gameDefinition.findMany({ select: { code: true, rulesJson: true } });
    const games = new Map<string, { isCrash: boolean; growthRate: number }>();
    for (const d of defs) {
      if (d.code === 'LUDO') continue;
      const rules = (d.rulesJson ?? {}) as { houseEdge?: unknown; growthRate?: unknown };
      const isCrash = typeof rules.houseEdge === 'number' && typeof rules.growthRate === 'number';
      games.set(d.code, { isCrash, growthRate: isCrash ? (rules.growthRate as number) : 0 });
    }
    this.catalog = { at: Date.now(), games };
    return games;
  }

  // Moves every unfinished round forward if its time has come and the queue
  // worker has not done it — see round-recovery.ts for the rules. Idempotent
  // and race-safe: open/lock/settle all claim the round atomically, so if the
  // queue worker got there first this simply finds nothing to do.
  private async sweep() {
    const games = await this.gameCatalog();
    if (games.size === 0) return;
    const rounds = await this.prisma.gameRound.findMany({
      where: { gameCode: { in: [...games.keys()] }, status: { in: ['SCHEDULED', 'OPEN', 'LOCKED', 'RESOLVING'] } },
      select: { id: true, gameCode: true, status: true, openAt: true, lockAt: true, hiddenState: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const now = Date.now();
    for (const round of rounds) {
      const game = games.get(round.gameCode)!;
      const crashPoint = (round.hiddenState as { crashPoint?: unknown } | null)?.crashPoint;
      const crashAt =
        game.isCrash && typeof crashPoint === 'number'
          ? new Date(round.lockAt.getTime() + crashTimeSeconds(crashPoint, game.growthRate) * 1000)
          : null;
      const action = planRoundRecovery(round, { isCrash: game.isCrash, crashAt }, now);
      if (action !== 'none') await this.apply(action, round.id, round.gameCode, game.isCrash);
    }
  }

  private async apply(action: RecoveryAction, roundId: string, gameCode: string, isCrash: boolean) {
    try {
      switch (action) {
        case 'open':
          await this.rounds.open(roundId);
          this.logger.log(`Opened ${gameCode} round ${roundId} (the queue had not).`);
          break;
        case 'lock':
          await this.rounds.lock(roundId);
          this.logger.log(`Locked ${gameCode} round ${roundId} (the queue had not).`);
          // Same as the queue's lock job: a non-crash round settles the moment
          // entries are cut off. A crash round settles at its crash time.
          if (!isCrash) await this.settlement.settle(roundId);
          break;
        case 'settle':
          await this.settlement.settle(roundId);
          this.logger.log(`Settled ${gameCode} round ${roundId} (the queue had not).`);
          break;
        case 'settle_crash':
          await this.crash.settleCrash(roundId);
          this.logger.log(`Settled crashed ${gameCode} round ${roundId} (the queue had not).`);
          break;
        case 'void': {
          const { refunded } = await this.settlement.voidRound(roundId);
          this.logger.warn(`${gameCode} round ${roundId} was left unfinished for over a minute; cancelled it and refunded ${refunded} entr${refunded === 1 ? 'y' : 'ies'}.`);
          break;
        }
        case 'abandon':
          if (!this.reported.has(roundId)) {
            this.reported.add(roundId);
            this.logger.error(
              `${gameCode} round ${roundId} has been stuck in RESOLVING for over ${Math.round(ABANDON_AFTER_MS / 60_000)} minutes: a payout stopped partway. ` +
                `It will not be touched automatically (some entries may already be paid). Inspect its entries; the game itself is not blocked by it.`,
            );
          }
          break;
      }
    } catch (err: any) {
      // Losing a race to the queue worker is expected and harmless.
      if (err instanceof BadRequestException || err instanceof NotFoundException) return;
      this.logger.error(`Could not ${action} ${gameCode} round ${roundId}: ${err?.message ?? err}`);
    }
  }

  private async ensureRound(gameCode: string, rulesVersion: number) {
    const startedAt = this.creating.get(gameCode);
    if (startedAt && Date.now() - startedAt < RoundSchedulerService.STEP_TIMEOUT_MS) return;

    // A round that crashed partway through paying out (RESOLVING for a long
    // time) is reported by the sweep and must not block the game forever.
    const inFlight = await this.prisma.gameRound.findFirst({
      where: {
        gameCode,
        OR: [
          { status: { in: ['SCHEDULED', 'OPEN', 'LOCKED'] } },
          { status: 'RESOLVING', lockAt: { gt: new Date(Date.now() - ABANDON_AFTER_MS) } },
        ],
      },
    });
    if (inFlight) return;

    // A just-settled round still counts as "recent enough" to respect the
    // idle gap above, so the hub doesn't instantly swap the settled result
    // for a brand new round mid-glance.
    const lastSettled = await this.prisma.gameRound.findFirst({
      where: { gameCode, status: 'SETTLED' },
      orderBy: { settledAt: 'desc' },
    });
    const gapMs = RoundSchedulerService.GAP_SECONDS * 1000;
    if (lastSettled?.settledAt && Date.now() - lastSettled.settledAt.getTime() < gapMs) return;

    this.creating.set(gameCode, Date.now());
    try {
      // The admin's settings win; the constants are only the fallback for a
      // game that has none set. (This comment block used to promise "read from
      // rulesJson first" while the code ignored it, so operators could not
      // retune round length or the minimum stake without a deploy.)
      const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode }, select: { rulesJson: true } });
      const rules = (game?.rulesJson ?? {}) as { openSeconds?: number; minStake?: number; diceCount?: number; diceSides?: number; houseEdge?: number; growthRate?: number };

      // Only the dice and crash shapes can be created automatically. A
      // Lucky-Number-shaped game needs a number range and pick count that
      // nothing supplies here, so its rounds would accept bets that can never
      // win. Refuse rather than take players' coins.
      const supported = (!!rules.diceCount && !!rules.diceSides) || (typeof rules.houseEdge === 'number' && typeof rules.growthRate === 'number');
      if (!supported) {
        if (!this.reported.has(`unsupported:${gameCode}`)) {
          this.reported.add(`unsupported:${gameCode}`);
          this.logger.error(`${gameCode} is Active but is not a dice or crash game, so no rounds are created for it (they could not be won). Set it to Disabled.`);
        }
        return;
      }
      const openSeconds = gameCode === 'SUM_DICE' ? 30 : (rules.openSeconds ?? RoundSchedulerService.DEFAULT_OPEN_SECONDS[gameCode] ?? 15);
      const entryPrice = rules.minStake ?? RoundSchedulerService.DEFAULT_ENTRY_PRICE[gameCode] ?? 10;
      const openAt = new Date();
      const lockAt = new Date(openAt.getTime() + openSeconds * 1000);

      await this.rounds.createRound({ gameCode, rulesVersion, entryPrice, openAt, lockAt });
      this.logger.log(`Opened a new ${gameCode} round (locks in ${openSeconds}s).`);
    } catch (err: any) {
      this.logger.error(`Could not auto-create a round for ${gameCode}: ${err.message}`);
    } finally {
      this.creating.delete(gameCode);
    }
  }
}
