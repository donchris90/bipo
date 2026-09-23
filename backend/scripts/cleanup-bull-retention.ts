import IORedis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is required');

const redis = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
const patterns = [
  'bull:pk-transitions:completed',
  'bull:pk-transitions:failed',
  'bull:pk-transitions:events',
  'bull:game-round-transitions:completed',
  'bull:game-round-transitions:failed',
  'bull:game-round-transitions:events',
];

async function main() {
  let deleted = 0;
  for (const key of patterns) {
    const exists = await redis.exists(key);
    if (exists) {
      await redis.del(key);
      deleted++;
      console.log(`Deleted ${key}`);
    }
  }
  console.log(`Removed ${deleted} BullMQ retention keys. Wait/active/delayed jobs were NOT deleted.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => redis.quit());
