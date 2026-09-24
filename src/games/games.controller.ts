import { GamesReadinessService } from './games-readiness';
import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { RoundService } from './round.service';
import { EntryService } from './entry.service';
import { SettlementService } from './settlement.service';
import { CrashService } from './crash.service';
import { GameAdminService } from './game-admin.service';
import { classifyResult, computePerNumberPool } from './sum-dice-rules';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName, GameStatus } from '@prisma/client';
import { buildLuckyQuotes, validateLuckyConfig, suggestedStakes, type LuckyNumberRulesConfig } from './lucky-number-rules';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

// Every client-facing round read goes through this projection. hiddenState
// carries engine-internal pre-settlement secrets (Crash's crashPoint is
// the reason this exists at all) and must never reach a response before
// settlement — using one shared select object means that's true by
// construction everywhere a round is read, not something each new
// endpoint has to remember to repeat correctly.
const ROUND_SELECT = {
  id: true,
  gameCode: true,
  rulesVersion: true,
  numberRange: true,
  selectionCount: true,
  entryPrice: true,
  openAt: true,
  lockAt: true,
  result: true,
  commitmentHash: true,
  revealData: true,
  status: true,
  createdAt: true,
  settledAt: true,
} as const;

@Controller('api/v1/games')
@UseGuards(JwtAuthGuard)
export class GamesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rounds: RoundService,
    private readonly entries: EntryService,
    private readonly settlement: SettlementService,
    private readonly crash: CrashService,
  ) {}

  // Public-to-authenticated players: Lucky Number's formula-derived odds,
  // multipliers, and stake weights. The legacy numberPayouts Admin map is
  // intentionally not read or returned for Lucky Number.
  @Get(':gameCode/config')
  async config(@Param('gameCode') gameCode: string) {
    const game = await this.prisma.gameDefinition.findUnique({
      where: { code: gameCode },
      select: { code: true, rulesJson: true },
    });
    const rules = (game?.rulesJson as any) ?? {};
    const isLuckyNumber = typeof rules.rtp === 'number' && typeof rules.basePrize === 'number' && rules.diceCount === 3 && rules.diceSides === 10;
    if (isLuckyNumber) {
      const lucky = validateLuckyConfig({ rtp: rules.rtp, basePrize: rules.basePrize, stakeWeightExponent: rules.stakeWeightExponent });
      const quotes = buildLuckyQuotes(lucky);
      return {
        gameCode,
        mode: 'LUCKY_NUMBER',
        rtp: lucky.rtp,
        basePrize: lucky.basePrize,
        stakeWeightExponent: lucky.stakeWeightExponent,
        payoutMultiplier: null,
        multipliers: Object.fromEntries(quotes.map((q) => [String(q.number), q.multiplier])),
        suggestedStakes: Object.fromEntries(quotes.map((q) => [String(q.number), q.suggestedStake])),
        odds: Object.fromEntries(quotes.map((q) => [String(q.number), q.probability])),
      };
    }
    return {
      gameCode,
      mode: 'LEGACY',
      rtp: null,
      basePrize: null,
      payoutMultiplier: typeof rules.payoutMultiplier === 'number' ? rules.payoutMultiplier : null,
      numberPayouts: rules.numberPayouts && typeof rules.numberPayouts === 'object' ? rules.numberPayouts : {},
      multipliers: {},
      suggestedStakes: {},
      odds: {},
    };
  }

  @Get(':gameCode/lucky-number/suggestions')
  async luckySuggestions(@Param('gameCode') gameCode: string) {
    const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode }, select: { rulesJson: true } });
    const rules = (game?.rulesJson ?? {}) as Record<string, unknown>;
    if (gameCode !== 'SUM_DICE' || rules.diceCount !== 3 || rules.diceSides !== 10) {
      return { applicable: false };
    }
    const lucky = validateLuckyConfig({ rtp: Number(rules.rtp), basePrize: Number(rules.basePrize), stakeWeightExponent: rules.stakeWeightExponent as number | undefined });
    const quotes = buildLuckyQuotes(lucky);
    return {
      applicable: true,
      rtp: lucky.rtp,
      basePrize: lucky.basePrize,
      stakeWeightExponent: lucky.stakeWeightExponent,
      quotes,
      suggestedStakes: suggestedStakes(quotes.map((q) => q.number), lucky),
    };
  }

  @Get(':gameCode/rounds')
  listRounds(@Param('gameCode') gameCode: string) {
    return this.prisma.gameRound.findMany({
      where: { gameCode },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: ROUND_SELECT,
    });
  }

  // Matches the "Time | Result | Winners | Prize" history table observed
  // in the reference client — a pure read-time aggregation over GameEntry,
  // not a new stored table, so it can't drift out of sync with the actual
  // entries. One extra pair of queries per round (winner count/prize,
  // total wagered) rather than a single joined query — fine at the current
  // scale (same tradeoff already made in ReconciliationService.checkAll);
  // batch with a GROUP BY if this ever needs to scale past a couple dozen
  // rounds per request.
  @Get(':gameCode/history')
  async history(@Param('gameCode') gameCode: string) {
    const rounds = await this.prisma.gameRound.findMany({
      where: { gameCode, status: 'SETTLED' },
      orderBy: { settledAt: 'desc' },
      take: 20,
      select: ROUND_SELECT,
    });

    return Promise.all(
      rounds.map(async (round) => {
        const [wonAgg, totalAgg] = await Promise.all([
          this.prisma.gameEntry.aggregate({
            where: { roundId: round.id, status: 'WON' },
            _count: { _all: true },
            _sum: { rewardAmount: true },
          }),
          this.prisma.gameEntry.aggregate({
            where: { roundId: round.id },
            _count: { _all: true },
            _sum: { coinAmount: true },
          }),
        ]);

        return {
          roundId: round.id,
          settledAt: round.settledAt,
          result: round.result,
          winners: wonAgg._count._all, // counts winning entries, not distinct users — a player who places 2 winning entries counts as 2 here
          prize: wonAgg._sum.rewardAmount ?? 0,
          players: totalAgg._count._all, // same caveat — entry count, not distinct-user count
          totalWagered: totalAgg._sum.coinAmount ?? 0,
        };
      }),
    );
  }

  // Live totals shown above the Lucky Number board. Players are distinct
  // users, while totalWagered is the sum of currently placed stakes.
  @Get('rounds/:roundId/live-stats')
  async liveStats(@Param('roundId') roundId: string) {
    const where = { roundId, status: 'PLACED' as const };
    const [players, total] = await Promise.all([
      this.prisma.gameEntry.findMany({ where, distinct: ['userId'], select: { userId: true } }),
      this.prisma.gameEntry.aggregate({ where, _sum: { coinAmount: true } }),
    ]);
    return { players: players.length, totalWagered: total._sum.coinAmount ?? 0 };
  }

  @Get('rounds/:roundId')
  getRound(@Param('roundId') roundId: string) {
    return this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId }, select: ROUND_SELECT });
  }

  // The client's own entries for a round, once it exists to ask about —
  // needed so the win banner can show a real settled reward amount
  // instead of recomputing the payout multiplier client-side (which
  // would drift the moment settlement.service.ts's rulesJson-driven
  // multiplier changes).
  @Get('rounds/:roundId/entries/mine')
  myEntries(@Param('roundId') roundId: string, @Req() req: AuthedRequest) {
    return this.prisma.gameEntry.findMany({
      where: { roundId, userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, selection: true, coinAmount: true, rewardAmount: true, netAmount: true, status: true, createdAt: true },
    });
  }

  // Live "how much has been staked on each number" — the subscript numbers
  // seen under each grid button in the reference app. Only meaningful for
  // sum-dice-shaped rounds (selectionCount null) — Lucky Number's win
  // condition is a full-set match, not "is my number among several I
  // picked," so attributing its stake per-number the same way would be
  // actively misleading, not just unavailable.
  @Get('rounds/:roundId/pool')
  async pool(@Param('roundId') roundId: string) {
    const round = await this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId }, select: ROUND_SELECT });
    if (round.selectionCount != null) {
      return { applicable: false, reason: 'Per-number pool only applies to sum-dice-shaped games' };
    }
    const entries = await this.prisma.gameEntry.findMany({
      where: { roundId },
      select: { selection: true, coinAmount: true },
    });
    const pool = new Map<number, number>();
    for (const entry of entries) {
      const selection: any = entry.selection;
      if (selection && !Array.isArray(selection) && selection.stakes && typeof selection.stakes === 'object') {
        for (const [key, value] of Object.entries(selection.stakes)) pool.set(Number(key), (pool.get(Number(key)) ?? 0) + Number(value));
      } else if (Array.isArray(selection)) {
        const per = selection.length ? Math.floor(entry.coinAmount / selection.length) : 0;
        for (const n of selection) pool.set(Number(n), (pool.get(Number(n)) ?? 0) + per);
      }
    }
    return { applicable: true, pool: Object.fromEntries(pool) };
  }

  // Streak/pattern data behind the reference app's Statistics screen
  // (the "B B B S S B..." sequence view). Purely descriptive — nothing in
  // this codebase (or the RNG it's built on) uses past results to bias
  // future ones, and this endpoint must never be read that way.
  @Get(':gameCode/stats')
  async stats(@Param('gameCode') gameCode: string) {
    const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode } });
    const rules = (game?.rulesJson as any) ?? {};
    if (!rules.diceCount || !rules.diceSides) {
      return { applicable: false, reason: 'Small/Big/Odd/Even stats only apply to sum-dice-shaped games' };
    }
    const maxSumValue = rules.diceCount * (rules.diceSides - 1);

    const rounds = await this.prisma.gameRound.findMany({
      where: { gameCode, status: 'SETTLED' },
      orderBy: { settledAt: 'desc' },
      take: 30,
      select: ROUND_SELECT,
    });

    const sequence = rounds
      .map((r) => (r.result as any)?.sum)
      .filter((sum): sum is number => typeof sum === 'number')
      .map((sum) => classifyResult(sum, maxSumValue));

    return { applicable: true, sequence };
  }

  // Biggest recent payouts — the "1000X" tab in the reference app. Sorted
  // by absolute coins won, not by multiplier achieved (an entry split
  // across many numbers can win a smaller absolute amount at the same
  // flat multiplier as a concentrated bet — see computeSumDiceReward).
  // Two-step query rather than a nested relation filter: GameEntry only
  // stores roundId as a plain string (same deliberate no-relations
  // pattern as Follow/Block elsewhere in this schema), so there's no
  // `round.gameCode` path to filter through directly.
  @Get(':gameCode/big-wins')
  async bigWins(@Param('gameCode') gameCode: string) {
    const roundIds = await this.prisma.gameRound.findMany({
      where: { gameCode },
      select: { id: true },
      take: 500, // recent-enough window that a big win outside it is not worth surfacing anyway
      orderBy: { createdAt: 'desc' },
    });

    const entries = await this.prisma.gameEntry.findMany({
      where: { status: 'WON', roundId: { in: roundIds.map((r) => r.id) } },
      orderBy: { rewardAmount: 'desc' },
      take: 20,
      select: { id: true, userId: true, rewardAmount: true, coinAmount: true, roundId: true, createdAt: true },
    });
    return entries;
  }

  @Get('rounds/:roundId/reveal')
  async reveal(@Param('roundId') roundId: string) {
    const round = await this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId }, select: ROUND_SELECT });
    return this.rounds.reveal(round);
  }

  // Crash only — live, poll-friendly multiplier for the client's
  // animation. Server-computed from elapsed time every call, never a
  // stored/ticked value — see CrashService.getStatus. Harmless to call for
  // a non-Crash round; it just reports the round's ordinary status with a
  // flat 1.0 multiplier.
  @Get('rounds/:roundId/multiplier')
  multiplier(@Param('roundId') roundId: string) {
    return this.crash.getStatus(roundId);
  }

  // Crash only — a live, human-timed decision, unlike every other game's
  // action which resolves automatically. See CrashService.cashOut for why
  // this needs its own endpoint rather than fitting the generic entry
  // lifecycle.
  @Post('rounds/:roundId/cashout')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  cashOut(@Param('roundId') roundId: string, @Req() req: AuthedRequest) {
    return this.crash.cashOut(roundId, req.user.userId);
  }

  @Post('rounds/:roundId/entries')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  placeEntry(
    @Param('roundId') roundId: string,
    @Body('selection') selection: unknown,
    @Body('stakeAmount') stakeAmount: number | undefined,
    @Body('autoCashoutMultiplier') autoCashoutMultiplier: number | undefined,
    @Body('useBonus') useBonus: boolean | undefined,
    @Body('idempotencyKey') idempotencyKey: string,
    @Req() req: AuthedRequest,
  ) {
    return this.entries.place({
      userId: req.user.userId,
      countryCode: req.user.countryCode,
      roundId,
      selection,
      stakeAmount,
      autoCashoutMultiplier,
      useBonus,
      idempotencyKey: idempotencyKey ?? uuid(),
    });
  }
}

@Controller('api/v1/admin/games')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.GAME_OPERATOR, RoleName.SUPER_ADMIN)
export class GameOperatorController {
  constructor(
    private readonly rounds: RoundService,
    private readonly settlement: SettlementService,
    private readonly gameAdmin: GameAdminService,
    private readonly readiness: GamesReadinessService,
  ) {}

  // "Why can't people play?" — every condition a game needs, and which is missing.
  @Get('readiness')
  readinessReport() {
    return this.readiness.report();
  }

  // Restricted to SUPER_ADMIN, not GAME_OPERATOR — flipping a game live is
  // the legal-clearance gate from spec §96, a bigger decision than the
  // round-level operations below.
  @Put(':gameCode/status')
  @Roles(RoleName.SUPER_ADMIN)
  setGameStatus(@Param('gameCode') gameCode: string, @Body('status') status: GameStatus, @Req() req: AuthedRequest) {
    return this.gameAdmin.setStatus(gameCode, status, req.user.userId, req.user.roles);
  }

  // Creates or updates a game's definition (name/rulesJson/minAge) —
  // separate from status, and separate from creating a round. New games
  // land DISABLED regardless of what's posted here.
  @Put(':gameCode')
  @Roles(RoleName.SUPER_ADMIN)
  upsertGame(
    @Param('gameCode') gameCode: string,
    @Body('name') name: string,
    @Body('minAge') minAge: number | undefined,
    @Body('rulesJson') rulesJson: Record<string, unknown> | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.gameAdmin.upsert(gameCode, { name, minAge, rulesJson }, req.user.userId, req.user.roles);
  }

  @Put(':gameCode/regions/:countryCode')
  @Roles(RoleName.SUPER_ADMIN)
  setRegionEnabled(
    @Param('gameCode') gameCode: string,
    @Param('countryCode') countryCode: string,
    @Body('enabled') enabled: boolean,
    @Req() req: AuthedRequest,
  ) {
    return this.gameAdmin.setRegionEnabled(gameCode, countryCode, enabled, req.user.userId, req.user.roles);
  }

  @Get(':gameCode/regions')
  listRegions(@Param('gameCode') gameCode: string) {
    return this.gameAdmin.listRegions(gameCode);
  }

  @Post('rounds')
  createRound(
    @Body('gameCode') gameCode: string,
    @Body('rulesVersion') rulesVersion: number,
    @Body('numberRange') numberRange: number,
    @Body('selectionCount') selectionCount: number,
    @Body('entryPrice') entryPrice: number,
    @Body('openAt') openAt: string,
    @Body('lockAt') lockAt: string,
  ) {
    return this.rounds.createRound({
      gameCode,
      rulesVersion,
      numberRange,
      selectionCount,
      entryPrice,
      openAt: new Date(openAt),
      lockAt: new Date(lockAt),
    });
  }

  @Post('rounds/:roundId/open')
  open(@Param('roundId') roundId: string) {
    return this.rounds.open(roundId);
  }

  @Post('rounds/:roundId/lock')
  lock(@Param('roundId') roundId: string) {
    return this.rounds.lock(roundId);
  }

  @Post('rounds/:roundId/settle')
  settle(@Param('roundId') roundId: string) {
    return this.settlement.settle(roundId);
  }
}
