import { Module } from '@nestjs/common';
import { CreatorApplicationService } from './creator-application.service';
import { CreatorAnalyticsService } from './creator-analytics.service';
import { WithdrawalService, PAYOUT_PROVIDER } from './withdrawal.service';
import {
  CreatorsController,
  CreatorApplicationsAdminController,
  WithdrawalsController,
} from './creators.controller';
import { PayoutWebhookController } from './payout-webhook.controller';
import { MockPayoutProvider, UnavailablePayoutProvider } from './providers/payout-provider.interface';
import { PaystackPayoutProvider } from './providers/paystack-payout-provider';
import { PayoutsModule } from '../payouts/payouts.module';
import { PayoutEventsRegistrar } from './payout-events.registrar';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { isProduction } from '../common/provider-mode';
import { EconomyModule } from '../economy/economy.module';
import { RiskModule } from '../risk/risk.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [EconomyModule, RiskModule, NotificationsModule, PayoutsModule, ConfigModule],
  providers: [
    CreatorApplicationService,
    CreatorAnalyticsService,
    WithdrawalService,
    PayoutEventsRegistrar,
    {
      provide: PAYOUT_PROVIDER,
      inject: [ConfigService],
      // With a Paystack key: real transfers. Without one, development gets the
      // mock (it invents a payout reference and never moves money), while
      // production refuses withdrawals (503) instead of pretending.
      useFactory: (config: ConfigService) => {
        if (config.get<string>('PAYSTACK_SECRET_KEY')) return new PaystackPayoutProvider(config);
        return isProduction(config.get<string>('NODE_ENV')) ? new UnavailablePayoutProvider() : new MockPayoutProvider();
      },
    },
  ],
  controllers: [
    CreatorsController,
    CreatorApplicationsAdminController,
    WithdrawalsController,
    PayoutWebhookController,
  ],
  exports: [CreatorApplicationService, WithdrawalService],
})
export class CreatorsModule {}
