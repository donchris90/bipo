import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { createRedisConnection, PK_QUEUE_NAME, GAME_QUEUE_NAME } from '../queue/queue.config';
import { PkService } from '../pk/pk.service';
import { RoundService } from '../games/round.service';
import { SettlementService } from '../games/settlement.service';
import { CrashService } from '../games/crash.service';

// Workers are created here, not in QueueModule, specifically so
// PkModule/GamesModule (the queue producers) never need to depend on this
// module — only this module depends on them. Keeps the dependency graph
// one-directional: JobsModule -> {PkModule, GamesModule}.
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private pkWorker?: Worker;
  private gameWorker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly pk: PkService,
    private readonly rounds: RoundService,
    private readonly settlement: SettlementService,
    private readonly crash: CrashService,
  ) {}

  onModuleInit() {
    this.pkWorker = new Worker(
      PK_QUEUE_NAME,
      async (job) => {
        const { battleId } = job.data as { battleId: string };
        if (job.name === 'activate') return this.pk.activateIfDue(battleId);
        if (job.name === 'settle') return this.pk.settleIfDue(battleId);
      },
      { connection: createRedisConnection(this.config) },
    );
    this.pkWorker.on('failed', (job, err) =>
      this.logger.error(`PK job ${job?.name} (${job?.id}) failed: ${err.message}`),
    );

    this.gameWorker = new Worker(
      GAME_QUEUE_NAME,
      async (job) => {
        const { roundId } = job.data as { roundId: string };
        if (job.name === 'open') return this.rounds.open(roundId);
        if (job.name === 'lock') {
          const locked = await this.rounds.lock(roundId);
          // Crash-shaped rounds only start their live rising phase here —
          // settlement happens later, at the separately-scheduled 'crash'
          // job, not immediately. Every other game settles right away
          // since there's no live phase to wait out.
          const crashRules = await this.crash.crashRulesFor(locked.gameCode);
          if (crashRules) return locked;
          return this.settlement.settle(roundId);
        }
        if (job.name === 'crash') {
          return this.crash.settleCrash(roundId);
        }
      },
      { connection: createRedisConnection(this.config) },
    );
    this.gameWorker.on('failed', (job, err) =>
      this.logger.error(`Game round job ${job?.name} (${job?.id}) failed: ${err.message}`),
    );
  }

  async onModuleDestroy() {
    await Promise.all([this.pkWorker?.close(), this.gameWorker?.close()]);
  }
}
