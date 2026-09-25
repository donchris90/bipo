import { Module } from '@nestjs/common';
import { CallsService } from './calls.service';
import { CallsController, AdminCallsController } from './calls.controller';
import { LiveModule } from '../live/live.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EconomyModule } from '../economy/economy.module';
import { HostLevelsModule } from '../host-levels/host-levels.module';

@Module({
  imports: [LiveModule, RealtimeModule, NotificationsModule, EconomyModule, HostLevelsModule],
  providers: [CallsService],
  controllers: [CallsController, AdminCallsController],
  exports: [CallsService],
})
export class CallsModule {}
