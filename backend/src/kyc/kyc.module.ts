import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsModule } from '../notifications/notifications.module';
import { KycAdminController, KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { KycRetentionService } from './kyc-retention.service';

@Module({
  imports: [ConfigModule, NotificationsModule],
  controllers: [KycController, KycAdminController],
  providers: [KycService, KycRetentionService],
  exports: [KycService],
})
export class KycModule {}
