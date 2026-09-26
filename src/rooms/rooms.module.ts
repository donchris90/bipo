import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { RoomReaperService } from './room-reaper.service';
import { RoomsController } from './rooms.controller';
import { ModerationModule } from '../moderation/moderation.module';
import { LiveModule } from '../live/live.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GamesModule } from '../games/games.module';

@Module({
  // GamesModule is needed so a closing Party Room can tell LudoService to resolve any Ludo
  // table it's hosting (see RoomsService.finishClose) instead of leaving it orphaned.
  imports: [ModerationModule, LiveModule, RealtimeModule, NotificationsModule, GamesModule],
  providers: [RoomsService, RoomReaperService],
  controllers: [RoomsController],
  exports: [RoomsService],
})
export class RoomsModule {}
