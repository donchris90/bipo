import { Module } from '@nestjs/common';
import { RrydaLevelsService } from './rryda-levels.service';
import { RrydaLevelsController, AdminRrydaLevelsController } from './rryda-levels.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [RrydaLevelsController, AdminRrydaLevelsController],
  providers: [RrydaLevelsService],
  exports: [RrydaLevelsService],
})
export class RrydaLevelsModule {}
