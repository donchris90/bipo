import { Module } from '@nestjs/common';
import { PkService } from './pk.service';
import { PkController } from './pk.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RrydaExperienceModule } from '../experience/experience.module';
import { SeasonsModule } from '../seasons/seasons.module';

@Module({
  imports: [RealtimeModule, NotificationsModule, RrydaExperienceModule],
  providers: [PkService],
  controllers: [PkController],
  exports: [PkService],
})
export class PkModule {}
