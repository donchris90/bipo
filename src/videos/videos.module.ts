import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';
import { StorageController } from './storage.controller';
import { MockStorageProvider, STORAGE_PROVIDER, UnavailableStorageProvider } from './providers/storage-provider.interface';
import { isProduction } from '../common/provider-mode';
import { S3StorageProvider } from './providers/s3-storage-provider';

const logger = new Logger('VideosModule');

@Module({
  imports: [ConfigModule],
  providers: [
    VideosService,
    {
      provide: STORAGE_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('S3_BUCKET')) {
          try {
            return new S3StorageProvider(config);
          } catch (e: any) {
            // A wrong setting must not take the whole API down. Video uploads answer 503 with the reason instead.
            logger.error(`Video storage is misconfigured: ${e?.message ?? e}`);
            return new UnavailableStorageProvider(e?.message ?? 'check the S3_* settings');
          }
        }
        if (isProduction(config.get<string>('NODE_ENV'))) {
          logger.error('S3_BUCKET is not set — video uploads are DISABLED (503) until storage is configured.');
          return new UnavailableStorageProvider();
        }
        // Loud, like the Agora / Paystack fallbacks: a deployment that meant
        // to store real videos but has a missing env var must not find out by
        // publishing videos nobody can play.
        logger.warn(
          'S3_BUCKET not set — falling back to MockStorageProvider. ' +
            'Published videos will have URLs that cannot be played until storage is configured.',
        );
        return new MockStorageProvider();
      },
    },
  ],
  controllers: [VideosController, StorageController],
})
export class VideosModule {}
