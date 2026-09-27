import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { STORAGE_PROVIDER, type StorageProvider } from '../videos/providers/storage-provider.interface';
import { PrismaService } from '../prisma/prisma.service';

@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  @Get('ready')
  async readiness() {
    const checks: Record<string, any> = {};
    try { await this.prisma.$queryRaw`SELECT 1`; checks.database = 'ok'; }
    catch { checks.database = 'unavailable'; }

    const redis = new IORedis(this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true });
    try { await redis.connect(); await redis.ping(); checks.redis = 'ok'; }
    catch { checks.redis = 'unavailable'; }
    finally { await redis.quit().catch(() => undefined); }

    try {
      const result = this.storage.check ? await this.storage.check() : { ok: false, errorName: 'Unsupported' };
      checks.storage = result.ok ? 'ok' : (result.errorName === 'MockStorage' ? 'development-mock' : 'unavailable');
    } catch { checks.storage = 'unavailable'; }

    const ready = checks.database === 'ok' && checks.redis === 'ok' && (checks.storage === 'ok' || this.config.get<string>('NODE_ENV') !== 'production');
    const body = { status: ready ? 'ready' : 'not_ready', checks, timestamp: new Date().toISOString() };
    if (!ready) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  @Get()
  async check() {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        database: 'ok',
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new HttpException(
        {
          status: 'degraded',
          database: 'unavailable',
          latencyMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
