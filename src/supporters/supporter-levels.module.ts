import { Module } from '@nestjs/common';
import { SupporterLevelsService } from './supporter-levels.service';
import { SupporterLevelsController, AdminSupporterLevelsController } from './supporter-levels.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [SupporterLevelsController, AdminSupporterLevelsController],
  providers: [SupporterLevelsService],
  exports: [SupporterLevelsService],
})
export class SupporterLevelsModule {}
