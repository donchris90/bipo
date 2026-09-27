import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createRedisConnection, PK_QUEUE_NAME, GAME_QUEUE_NAME, RECONCILIATION_QUEUE_NAME, DEAD_LETTER_QUEUE_NAME, C2C_QUEUE_NAME } from './queue.config';

export const PK_QUEUE = 'PK_QUEUE';
export const GAME_QUEUE = 'GAME_QUEUE';
export const RECONCILIATION_QUEUE = 'RECONCILIATION_QUEUE';
export const DEAD_LETTER_QUEUE = 'DEAD_LETTER_QUEUE';
export const C2C_QUEUE = 'C2C_QUEUE';

// @Global + exported so PkService/RoundService can inject these without
// every module in the chain re-importing QueueModule. Workers (which
// actually process these queues) live in JobsModule — deliberately kept
// separate so PkModule/GamesModule (producers) never need to import
// JobsModule, avoiding a circular dependency.
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PK_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Queue(PK_QUEUE_NAME, {
        connection: createRedisConnection(config),
        defaultJobOptions: {
          removeOnComplete: { age: 3600, count: 500 },
          removeOnFail: { age: 86400, count: 1000 },
          attempts: 4,
          backoff: { type: 'exponential', delay: 2000 },
        },
        streams: { events: { maxLen: 1000 } },
      }),
    },
    {
      provide: GAME_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Queue(GAME_QUEUE_NAME, {
          connection: createRedisConnection(config),
          defaultJobOptions: {
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86400, count: 2000 },
            attempts: 4,
            backoff: { type: 'exponential', delay: 2000 },
          },
          streams: { events: { maxLen: 1000 } },
        }),
    },
    {
      provide: RECONCILIATION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Queue(RECONCILIATION_QUEUE_NAME, {
          connection: createRedisConnection(config),
          defaultJobOptions: {
            removeOnComplete: { age: 86400, count: 100 },
            removeOnFail: { age: 604800, count: 100 },
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          },
          streams: { events: { maxLen: 500 } },
        }),
    },
    {
      provide: DEAD_LETTER_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Queue(DEAD_LETTER_QUEUE_NAME, {
        connection: createRedisConnection(config),
        defaultJobOptions: { removeOnComplete: { age: 604800, count: 5000 } },
        streams: { events: { maxLen: 5000 } },
      }),
    },
    {
      provide: C2C_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Queue(C2C_QUEUE_NAME, {
        connection: createRedisConnection(config),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 86400, count: 500 },
          removeOnFail: { age: 604800, count: 1000 },
        },
        streams: { events: { maxLen: 1000 } },
      }),
    },
  ],
  exports: [PK_QUEUE, GAME_QUEUE, RECONCILIATION_QUEUE, DEAD_LETTER_QUEUE, C2C_QUEUE],
})
export class QueueModule {}
