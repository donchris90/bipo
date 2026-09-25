import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { HostLevelsModule } from '../host-levels/host-levels.module';

@Module({
  imports: [NotificationsModule, HostLevelsModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
