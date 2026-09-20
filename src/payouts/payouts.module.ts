import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { PayoutsController } from './payouts.controller';
import { PayoutConfigService } from './payout-config.service';
import { PayoutAccountService } from './payout-account.service';
import { BANK_PROVIDER, chooseBankProvider } from './bank-provider';

@Module({
  imports: [ConfigModule, NotificationsModule, AuditModule],
  controllers: [PayoutsController],
  providers: [
    PayoutConfigService,
    PayoutAccountService,
    { provide: BANK_PROVIDER, inject: [ConfigService], useFactory: (config: ConfigService) => chooseBankProvider(config) },
  ],
  exports: [PayoutConfigService, PayoutAccountService, BANK_PROVIDER],
})
export class PayoutsModule {}
