// One-off script: connects to Redis, shows memory usage, flushes everything,
// then confirms memory dropped. Safe to delete after you've run it once.
//
// Usage (from C:\rydaapp\backend):
//   node flush-redis.js

const Redis = require('ioredis');

const REDIS_URL = 'rediss://red-d9orrcugekts73emtbag:NXC8XHy0sJSWSSWmcDlC9yLvQ0e5CILB@oregon-keyvalue.render.com:6379';

async function main() {
  const redis = new Redis(REDIS_URL, { tls: {} });

  redis.on('error', (err) => console.error('Redis connection error:', err.message));

  await redis.ping();
  console.log('Connected.');

  const before = await redis.info('memory');
  const beforeUsed = before.match(/used_memory_human:(.+)/)?.[1]?.trim();
  console.log('Memory before flush:', beforeUsed);

  await redis.flushall();
  console.log('Flushed all keys.');

  const after = await redis.info('memory');
  const afterUsed = after.match(/used_memory_human:(.+)/)?.[1]?.trim();
  console.log('Memory after flush:', afterUsed);

  await redis.quit();
}

main().catch((err) => {
  console.error('Script failed:', err.message);
  process.exit(1);
});
