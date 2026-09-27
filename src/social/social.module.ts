import { Module } from '@nestjs/common';
import { SocialService } from './social.service';
import { SocialController } from './social.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { RrydaLevelsModule } from '../rryda-levels/rryda-levels.module';
import { TeamsModule } from '../teams/teams.module';
import { SeasonsModule } from '../seasons/seasons.module';

@Module({
  imports: [NotificationsModule, RrydaLevelsModule, TeamsModule, SeasonsModule],
  providers: [SocialService],
  controllers: [SocialController],
  exports: [SocialService],
})
export class SocialModule {}
