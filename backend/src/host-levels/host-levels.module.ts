import { Module } from '@nestjs/common';
import { HostLevelsService } from './host-levels.service';
import { HostLevelsController, AdminHostLevelsController } from './host-levels.controller';
import { HostRankingController } from './host-ranking.controller';
import { HostRankingService } from './host-ranking.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [HostLevelsController, AdminHostLevelsController, HostRankingController],
  providers: [HostLevelsService, HostRankingService],
  exports: [HostLevelsService],
})
export class HostLevelsModule {}
