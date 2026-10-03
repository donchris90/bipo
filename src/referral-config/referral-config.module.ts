import { Module } from '@nestjs/common';
import { ReferralConfigService } from './referral-config.service';
import { ReferralConfigController } from './referral-config.controller';

@Module({
  providers: [ReferralConfigService],
  controllers: [ReferralConfigController],
  exports: [ReferralConfigService],
})
export class ReferralConfigModule {}
