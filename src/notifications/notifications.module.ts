import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PushService } from './push.service';
import { ExpoPushProvider, NoopPushProvider, PUSH_PROVIDER } from './push-provider';
import { RealtimeModule } from '../realtime/realtime.module';

const logger = new Logger('NotificationsModule');

@Module({
  imports: [ConfigModule, RealtimeModule],
  providers: [
    NotificationsService,
    PushService,
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Opt-in, so a dev machine never makes outbound push calls by surprise.
        if (config.get<string>('PUSH_PROVIDER') === 'expo') {
          return new ExpoPushProvider(config.get<string>('EXPO_ACCESS_TOKEN') || undefined);
        }
        logger.warn('PUSH_PROVIDER is not "expo" — phone push notifications are disabled (in-app notifications still work).');
        return new NoopPushProvider();
      },
    },
  ],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
