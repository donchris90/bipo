import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegionalConfigService } from '../config/regional-config.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { RngService } from './rng.service';
import { maxSum, DiceConfig } from './sum-dice-rules';
import { CrashService } from './crash.service';
import type { Queue } from 'bullmq';
import { GAME_QUEUE } from '../queue/queue.module';

// How long createRound waits for Redis to accept the transition jobs before
// carrying on without them. See the comment where it is used.
const QUEUE_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

@Injectable()
export class RoundService {
  private readonly logger = new Logger(RoundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly regionalConfig: RegionalConfigService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly rng: RngService,
    private readonly crash: CrashService,
    @Inject(GAME_QUEUE) private readonly gameQueue: Queue,
  ) {}

  // Hard gate: BOTH the country-wide games switch AND this specific game's
  // per-country override must be true. Client hiding a disabled game is
  // never sufficient (spec §50) — every entry-placing call re-checks this,
  // not just the round-listing call.
  async assertGameAvailable(gameCode: string, countryCode: string) {
    if (await this.featureFlags.isEnabled('DISABLE_GAMES')) {
      throw new ForbiddenException('Games are temporarily disabled platform-wide');
    }

    const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode } });
    if (!game || game.status !== 'ACTIVE') throw new ForbiddenException('This game is not currently active');

    const countryGamesEnabled = await this.regionalConfig.isGamesEnabled(countryCode);
    if (!countryGamesEnabled) throw new ForbiddenException('Games are not enabled in your country');

    const gameRegion = await this.prisma.gameRegionConfig.findUnique({
      where: { gameCode_countryCode: { gameCode, countryCode } },
    });
    if (!gameRegion?.enabled) throw new ForbiddenException('This game is not enabled in your country');
  }

  async createRound(params: {
    gameCode: string;
    rulesVersion: number;
    numberRange?: number;
    selectionCount?: number;
    entryPrice: number;
    openAt: Date;
    lockAt: Date;
  }) {
    if (params.lockAt <= params.openAt) throw new BadRequestException('lockAt must be after openAt');

    const game = await this.prisma.gameDefinition.findUnique({ where: { code: params.gameCode } });
    const rules = (game?.rulesJson as any) ?? {};

    // Sum-dice games (spec'd from a real reference client, not the original
    // doc) derive their range from dice config rather than the caller
    // passing it — the range is a function of diceCount/diceSides, not an
    // independent choice, so requiring it as a separate input would let it
    // drift out of sync with the actual draw logic below. LUCKY_NUMBER
    // keeps its original caller-supplied numberRange/selectionCount.
    // Crash-shaped games (houseEdge + growthRate in rulesJson) use neither
    // field at all — there's no "selection" concept in the numberRange
    // sense, just a stake and an optional cash-out target.
    let numberRange = params.numberRange;
    let selectionCount = params.selectionCount;
    const isCrash = typeof rules.houseEdge === 'number' && typeof rules.growthRate === 'number';
    if (rules.diceCount && rules.diceSides) {
      const diceConfig: DiceConfig = { diceCount: rules.diceCount, diceSides: rules.diceSides };
      numberRange = maxSum(diceConfig);
      selectionCount = undefined; // not applicable — a sum-dice entry can select any number of picks, not a fixed count
    } else if (isCrash) {
      numberRange = undefined;
      selectionCount = undefined;
    }

    const secret = this.rng.generateSecret();
    const roundData = JSON.stringify({
      gameCode: params.gameCode,
      openAt: params.openAt,
      lockAt: params.lockAt,
      numberRange,
    });
    const commitmentHash = this.rng.commitmentHash(secret, roundData);

    const created = await this.prisma.gameRound.create({
      data: {
        gameCode: params.gameCode,
        rulesVersion: params.rulesVersion,
        numberRange,
        selectionCount,
        entryPrice: params.entryPrice, // for sum-dice games, this is the MINIMUM total stake per entry, not a fixed price — see EntryService
        openAt: params.openAt,
        lockAt: params.lockAt,
        commitmentHash,
        revealData: secret, // stored now, only *disclosed* via the reveal endpoint after settlement
        status: 'SCHEDULED',
      },
    });

    const now = Date.now();

    // The crash point is generated here, at creation time, rather than at lock
    // time — the server needs to know exactly when the round will crash in
    // order to schedule the job that reveals it, which means it has to exist
    // (hidden) from the very start. This is the one meaningful difference from
    // Lucky Number/Sum Dice, where the draw isn't generated until settlement.
    // It is a database-only step, so it happens before anything touches Redis.
    let crashAt: Date | null = null;
    if (isCrash) {
      try {
        crashAt = await this.crash.initializeCrashRound(
          created.id,
          { houseEdge: rules.houseEdge, growthRate: rules.growthRate },
          params.lockAt,
        );
      } catch (e) {
        // A Crash round with no crash point can never be settled honestly.
        // Nothing has been opened yet, so no entries exist to refund.
        await this.prisma.gameRound.update({ where: { id: created.id }, data: { status: 'CANCELLED' } });
        throw e;
      }
    }

    // Queue the open/lock(/crash) jobs — best effort, with a time limit.
    //
    // This used to be awaited with no limit and, on failure, cancelled the
    // round. But the Redis client is configured to retry forever, so when
    // Redis was unreachable `queue.add()` never returned: the round stayed
    // SCHEDULED, this method never finished, and the scheduler (which will not
    // open a new round while one is unfinished) froze the game for good.
    //
    // Rounds no longer depend on these jobs to progress: RoundSchedulerService
    // opens, locks and settles anything that is due, straight from the
    // database, and refunds anything left overdue. The jobs remain the
    // precise-timing fast path when Redis is healthy; if they can't be queued
    // we say so loudly and carry on.
    try {
      await withTimeout(
        Promise.all([
          this.gameQueue.add('open', { roundId: created.id }, { delay: Math.max(params.openAt.getTime() - now, 0), jobId: `open-${created.id}` }),
          this.gameQueue.add('lock', { roundId: created.id }, { delay: Math.max(params.lockAt.getTime() - now, 0), jobId: `lock-${created.id}` }),
          ...(crashAt
            ? [this.gameQueue.add('crash', { roundId: created.id }, { delay: Math.max(crashAt.getTime() - now, 0), jobId: `crash-${created.id}` })]
            : []),
        ]),
        QUEUE_TIMEOUT_MS,
        'Queuing round jobs',
      );
    } catch (e: any) {
      this.logger.warn(
        `Could not queue jobs for round ${created.id} (${params.gameCode}): ${e?.message}. ` +
          `The round scheduler will drive it instead — but check that REDIS_URL is correct and reachable.`,
      );
    }
    // Settlement isn't scheduled by time here for non-Crash games — the
    // 'lock' job handler in JobsModule calls lock() and then
    // settlement.settle() back-to-back, since settlement should happen as
    // soon as entries are cut off, not on a separate timer. Crash is the
    // exception: 'lock' only starts the live rising phase, and the
    // separately-scheduled 'crash' job above is what actually settles it.

    // Explicit redaction, not reliance on `created` happening to predate
    // the hiddenState write — that was true by accident of timing, not by
    // any actual guarantee, and would silently break the moment this
    // method's caller changed to re-fetch the round after scheduling. This
    // is the same protection games.controller.ts's ROUND_SELECT gives
    // every other round-read path, applied here at the source so nothing
    // that calls createRound() can leak it by omission.
    const { hiddenState, ...safeRound } = created;
    return safeRound;
  }

  async open(roundId: string) {
    const round = await this.prisma.gameRound.findUnique({ where: { id: roundId } });
    if (!round) throw new NotFoundException('Round not found');
    if (round.status !== 'SCHEDULED') throw new BadRequestException('Round is not in SCHEDULED state');
    // Atomic: the queue worker and the round scheduler can both try this, and a
    // round cancelled in between must not be resurrected.
    const moved = await this.prisma.gameRound.updateMany({ where: { id: roundId, status: 'SCHEDULED' }, data: { status: 'OPEN' } });
    if (moved.count === 0) throw new BadRequestException('Round is not in SCHEDULED state');
    const updated = await this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    // Same redaction as createRound() — a Crash round's hiddenState is
    // already populated by this point (generated at creation), so a bare
    // return here would leak the crash point to anyone calling the admin
    // open endpoint directly.
    const { hiddenState, ...safeRound } = updated;
    return safeRound;
  }

  async lock(roundId: string) {
    const round = await this.prisma.gameRound.findUnique({ where: { id: roundId } });
    if (!round) throw new NotFoundException('Round not found');
    if (round.status !== 'OPEN') throw new BadRequestException('Round is not OPEN');
    const moved = await this.prisma.gameRound.updateMany({ where: { id: roundId, status: 'OPEN' }, data: { status: 'LOCKED' } });
    if (moved.count === 0) throw new BadRequestException('Round is not OPEN');
    const updated = await this.prisma.gameRound.findUniqueOrThrow({ where: { id: roundId } });
    // Same redaction, and more important here than in open(): this is the
    // exact moment a Crash round's live phase begins — the crash point has
    // been sitting in hiddenState since creation, and this return value
    // must not be the thing that finally exposes it.
    const { hiddenState, ...safeRound } = updated;
    return safeRound;
  }

  // Cutoff enforcement (spec §93): entries are only accepted while OPEN and
  // before lockAt — EntryService checks both, this is not solely a status
  // check, since a round can be OPEN in the DB for a moment past its lockAt
  // if the lock() transition hasn't run yet.
  async assertAcceptingEntries(round: { status: string; lockAt: Date }) {
    if (round.status !== 'OPEN') throw new BadRequestException('Round is not accepting entries');
    if (round.lockAt <= new Date()) throw new BadRequestException('Round entry cutoff has passed');
  }

  reveal(round: { revealData: string | null; commitmentHash: string | null; status: string }) {
    if (round.status !== 'SETTLED') throw new BadRequestException('Round not yet settled');
    return { secret: round.revealData, commitmentHash: round.commitmentHash };
  }
}
