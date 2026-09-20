import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import IORedis from 'ioredis';

export const PK_QUEUE_NAME = 'pk-transitions';
export const GAME_QUEUE_NAME = 'game-round-transitions';

const logger = new Logger('RedisConnection');

// BullMQ requires maxRetriesPerRequest: null on the ioredis connection it's
// given — each Queue/Worker gets its own client rather than sharing one,
// since BullMQ's blocking commands (used by Workers) don't play well with a
// connection also used for regular producer commands.
//
// ioredis does NOT log connection failures anywhere by default — with no
// listener attached, a bad URL, wrong credentials, or a TLS handshake
// failure fails completely silently: queue.add() calls still "succeed"
// (they queue the command locally waiting for a connection that may never
// come), and a Worker never processes anything, with nothing in any log
// telling you why. These listeners exist specifically so a broken Redis
// connection is visible instead of manifesting as "PK/game jobs just don't
// run" with no explanation.
export function createRedisConnection(config: ConfigService): IORedis {
  const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
  const client = new IORedis(url, { maxRetriesPerRequest: null });

  client.on('connect', () => logger.log('Redis: TCP connection established'));
  client.on('ready', () => logger.log('Redis: ready to accept commands'));
  client.on('error', (err) => logger.error(`Redis connection error: ${err.message}`));
  client.on('close', () => logger.warn('Redis: connection closed'));
  client.on('reconnecting', (delay: number) => logger.warn(`Redis: reconnecting in ${delay}ms`));

  return client;
}
