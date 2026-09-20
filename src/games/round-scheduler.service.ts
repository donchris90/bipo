import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoundService } from './round.service';
import { GameStatus } from '@prisma/client';

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
  private timer?: ReturnType<typeof setInterval>;
  // Per-gameCode in-flight guard so two overlapping poll ticks (or a tick
  // that's still awaiting a slow createRound) can't both decide "nothing
  // exists yet" and each create a round for the same game.
  private readonly creating = new Set<string>();

  // How long a fresh round stays OPEN for entries before it locks —
  // matches the reference UI copy this project was built against ("Fast
  // 15s Betting Round" for Lucky Number/Sum Dice; Crash uses a shorter
  // betting window since its own "round" is mostly the live climb that
  // follows). Read from rulesJson.openSeconds first so an operator can
  // retune a specific game without a code change; these are just the
  // fallback when that isn't set.
  private static readonly DEFAULT_OPEN_SECONDS: Record<string, number> = {
    CRASH: 8,
    SUM_DICE: 15,
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
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error(`Round scheduler tick failed: ${err.message}`));
    }, RoundSchedulerService.POLL_INTERVAL_MS);
    // Run once immediately too, rather than waiting out the first interval
    // after every deploy/restart.
    this.tick().catch((err) => this.logger.error(`Round scheduler tick failed: ${err.message}`));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const games = await this.prisma.gameDefinition.findMany({ where: { status: GameStatus.ACTIVE } });
    await Promise.all(games.map((game) => this.ensureRound(game.code, game.version)));
  }

  private async ensureRound(gameCode: string, rulesVersion: number) {
    if (this.creating.has(gameCode)) return;

    const inFlight = await this.prisma.gameRound.findFirst({
      where: { gameCode, status: { in: ['SCHEDULED', 'OPEN', 'LOCKED', 'RESOLVING'] } },
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

    this.creating.add(gameCode);
    try {
      // The admin's settings win; the constants are only the fallback for a
      // game that has none set. (This comment block used to promise "read from
      // rulesJson first" while the code ignored it, so operators could not
      // retune round length or the minimum stake without a deploy.)
      const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode }, select: { rulesJson: true } });
      const rules = (game?.rulesJson ?? {}) as { openSeconds?: number; minStake?: number };
      const openSeconds = rules.openSeconds ?? RoundSchedulerService.DEFAULT_OPEN_SECONDS[gameCode] ?? 15;
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
