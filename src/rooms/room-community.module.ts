import { Module } from '@nestjs/common';
import { RoomCommunityService } from './room-community.service';
import { RoomCommunityController, AdminRoomLevelsController } from './room-community.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { HostLevelsModule } from '../host-levels/host-levels.module';

// Deliberately its own module rather than folded into RoomsModule: EconomyModule needs
// RoomCommunityService too (GiftService.awardGiftXp hook), and RoomCommunityModule importing
// neither RoomsModule nor EconomyModule keeps that a plain import on both sides — no forwardRef.
@Module({
  imports: [NotificationsModule, HostLevelsModule],
  controllers: [RoomCommunityController, AdminRoomLevelsController],
  providers: [RoomCommunityService],
  exports: [RoomCommunityService],
})
export class RoomCommunityModule {}
