import { Module } from '@nestjs/common';
import { CallsService } from './calls.service';
import { CallsController } from './calls.controller';
import { LiveModule } from '../live/live.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [LiveModule, RealtimeModule, NotificationsModule],
  providers: [CallsService],
  controllers: [CallsController],
  exports: [CallsService],
})
export class CallsModule {}
