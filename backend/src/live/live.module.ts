import { LiveMediaService } from './live-media.service';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LiveService, RTC_PROVIDER } from './live.service';
import { LiveController } from './live.controller';
import { LiveReaperService } from './live-reaper.service';
import { MockRtcProvider, UnavailableRtcProvider } from './providers/rtc-provider.interface';
import { isProduction } from '../common/provider-mode';
import { AgoraRtcProvider } from './providers/agora-rtc-provider';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ModerationModule } from '../moderation/moderation.module';
import { EconomyModule } from '../economy/economy.module';
import { HostLevelsModule } from '../host-levels/host-levels.module';

const logger = new Logger('LiveModule');

@Module({
  imports: [FeatureFlagsModule, ConfigModule, RealtimeModule, ModerationModule, EconomyModule, HostLevelsModule],
  providers: [
    LiveService,
    LiveMediaService,
    LiveReaperService,
    {
      provide: RTC_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('AGORA_APP_ID') && config.get<string>('AGORA_APP_CERTIFICATE')) {
          return new AgoraRtcProvider(config);
        }
        if (isProduction(config.get<string>('NODE_ENV'))) {
          logger.error('AGORA_APP_ID / AGORA_APP_CERTIFICATE not set — live video is DISABLED (503) until configured.');
          return new UnavailableRtcProvider();
        }
        logger.warn(
          'AGORA_APP_ID / AGORA_APP_CERTIFICATE not set — falling back to MockRtcProvider. ' +
            'Live sessions will issue fake tokens no real client can use.',
        );
        return new MockRtcProvider();
      },
    },
  ],
  controllers: [LiveController],
  exports: [LiveService, LiveMediaService, RTC_PROVIDER],
})
export class LiveModule {}
