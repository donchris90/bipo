import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { RoomReaperService } from './room-reaper.service';
import { RoomsController } from './rooms.controller';
import { ModerationModule } from '../moderation/moderation.module';
import { LiveModule } from '../live/live.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ModerationModule, LiveModule, RealtimeModule, NotificationsModule],
  providers: [RoomsService, RoomReaperService],
  controllers: [RoomsController],
  exports: [RoomsService],
})
export class RoomsModule {}
