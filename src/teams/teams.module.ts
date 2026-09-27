import { Module } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { TeamsController, AdminTeamLevelsController } from './teams.controller';
import { NotificationsModule } from '../notifications/notifications.module';

// Same import shape as RrydaLevelsModule (NotificationsModule only) — deliberately, since anything
// that needs to call contributeXp() (missions, users, social, economy/gift) can safely import this
// module the same way they already import RrydaLevelsModule, with no circular-dependency risk.
@Module({
  imports: [NotificationsModule],
  controllers: [TeamsController, AdminTeamLevelsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
