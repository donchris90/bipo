import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { RoomReaperService } from './room-reaper.service';
import { RoomsController } from './rooms.controller';
import { ModerationModule } from '../moderation/moderation.module';
import { LiveModule } from '../live/live.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GamesModule } from '../games/games.module';
import { RoomCommunityModule } from './room-community.module';
import { SeasonsModule } from '../seasons/seasons.module';

@Module({
  // GamesModule is needed so a closing Party Room can tell LudoService to resolve any Ludo
  // table it's hosting (see RoomsService.finishClose) instead of leaving it orphaned.
  // RoomCommunityModule is the persistent-identity/XP/streak layer on top of PartyRoom
  // sessions — see room-community.service.ts.
  imports: [ModerationModule, LiveModule, RealtimeModule, NotificationsModule, GamesModule, RoomCommunityModule, SeasonsModule],
  providers: [RoomsService, RoomReaperService],
  controllers: [RoomsController],
  exports: [RoomsService],
})
export class RoomsModule {}
