import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { createRedisConnection, PK_QUEUE_NAME, GAME_QUEUE_NAME, RECONCILIATION_QUEUE_NAME, C2C_QUEUE_NAME } from '../queue/queue.config';
import { RECONCILIATION_QUEUE, DEAD_LETTER_QUEUE, C2C_QUEUE } from '../queue/queue.module';
import { PkService } from '../pk/pk.service';
import { RoundService } from '../games/round.service';
import { SettlementService } from '../games/settlement.service';
import { CrashService } from '../games/crash.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { C2CService } from '../c2c/c2c.service';

// Workers are created here, not in QueueModule, specifically so
// PkModule/GamesModule (the queue producers) never need to depend on this
// module — only this module depends on them. Keeps the dependency graph
// one-directional: JobsModule -> {PkModule, GamesModule}.
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private pkWorker?: Worker;
  private gameWorker?: Worker;
  private reconciliationWorker?: Worker;
  private c2cWorker?: Worker;
  private deadLetter?: Queue;

  constructor(
    private readonly config: ConfigService,
    private readonly pk: PkService,
    private readonly rounds: RoundService,
    private readonly settlement: SettlementService,
    private readonly crash: CrashService,
    private readonly reconciliation: ReconciliationService,
    private readonly c2c: C2CService,
    @Inject(RECONCILIATION_QUEUE) private readonly reconciliationQueue: Queue,
    @Inject(DEAD_LETTER_QUEUE) private readonly deadLetterQueue: Queue,
    @Inject(C2C_QUEUE) private readonly c2cQueue: Queue,
  ) {}

  onModuleInit() {
    this.deadLetter = this.deadLetterQueue;

    this.pkWorker = new Worker(
      PK_QUEUE_NAME,
      async (job) => {
        const { battleId } = job.data as { battleId: string };
        if (job.name === 'activate') return this.pk.activateIfDue(battleId);
        if (job.name === 'settle') return this.pk.settleIfDue(battleId);
      },
      { connection: createRedisConnection(this.config) },
    );
    this.pkWorker.on('failed', (job, err) => {
      this.logger.error(`PK job ${job?.name} (${job?.id}) failed: ${err.message}`);
      void this.deadLetterIfFinal(job, err, PK_QUEUE_NAME);
    });

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
    this.gameWorker.on('failed', (job, err) => {
      this.logger.error(`Game round job ${job?.name} (${job?.id}) failed: ${err.message}`);
      void this.deadLetterIfFinal(job, err, GAME_QUEUE_NAME);
    });

    this.reconciliationWorker = new Worker(
      RECONCILIATION_QUEUE_NAME,
      async (job) => {
        if (job.name === 'check-all') return this.reconciliation.runScheduledCheck();
      },
      { connection: createRedisConnection(this.config) },
    );
    this.reconciliationWorker.on('failed', (job, err) => {
      this.logger.error(`Reconciliation job ${job?.name} (${job?.id}) failed: ${err.message}`);
      void this.deadLetterIfFinal(job, err, RECONCILIATION_QUEUE_NAME);
    });

    this.c2cWorker = new Worker(
      C2C_QUEUE_NAME,
      async (job) => {
        if (job.name === 'expire') return this.c2c.expireStaleOrders();
      },
      { connection: createRedisConnection(this.config) },
    );
    this.c2cWorker.on('failed', (job, err) => {
      this.logger.error(`C2C job ${job?.name} (${job?.id}) failed: ${err.message}`);
      void this.deadLetterIfFinal(job, err, C2C_QUEUE_NAME);
    });

    const intervalMs = Math.max(
      60_000,
      Number(this.config.get<string>('RECONCILIATION_INTERVAL_MS') ?? 15 * 60_000),
    );
    void this.reconciliationQueue.upsertJobScheduler(
      'wallet-reconciliation-scheduler',
      { every: intervalMs },
      { name: 'check-all' },
    ).catch((err: Error) => this.logger.error(`Could not schedule wallet reconciliation: ${err.message}`));

    void this.c2cQueue.upsertJobScheduler(
      'c2c-expiry-scheduler',
      { every: Math.max(60_000, Number(this.config.get<string>('C2C_EXPIRY_INTERVAL_MS') ?? 60_000)) },
      { name: 'expire' },
    ).catch((err: Error) => this.logger.error(`Could not schedule C2C expiry: ${err.message}`));
  }

  private async deadLetterIfFinal(job: any, err: Error, sourceQueue: string) {
    if (!job || !this.deadLetter) return;
    const maxAttempts = Number(job.opts?.attempts ?? 1);
    if (Number(job.attemptsMade ?? 0) < maxAttempts) return;
    try {
      await this.deadLetter.add('failed-job', {
        sourceQueue,
        jobId: String(job.id ?? ''),
        name: String(job.name ?? ''),
        data: job.data ?? null,
        attemptsMade: Number(job.attemptsMade ?? 0),
        failedAt: new Date().toISOString(),
        error: String(err?.message ?? err).slice(0, 2000),
      }, { jobId: `dlq:${sourceQueue}:${String(job.id ?? Date.now())}` });
    } catch (dlqError: any) {
      this.logger.error(`Could not write failed ${sourceQueue} job to dead-letter queue: ${dlqError?.message ?? dlqError}`);
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.pkWorker?.close(), this.gameWorker?.close(), this.reconciliationWorker?.close(), this.c2cWorker?.close(), this.deadLetter?.close(), this.c2cQueue?.close()]);
  }
}
