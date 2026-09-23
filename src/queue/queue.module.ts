import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createRedisConnection, PK_QUEUE_NAME, GAME_QUEUE_NAME } from './queue.config';

export const PK_QUEUE = 'PK_QUEUE';
export const GAME_QUEUE = 'GAME_QUEUE';

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
          },
          streams: { events: { maxLen: 1000 } },
        }),
    },
  ],
  exports: [PK_QUEUE, GAME_QUEUE],
})
export class QueueModule {}
