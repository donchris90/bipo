import { CoinPackageAdminService } from './coin-package-admin.service';
import { CoinPackageAdminController } from './coin-package-admin.controller';
import { GiftAdminController } from './gift-admin.controller';
import { GiftAdminService } from './gift-admin';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WalletService } from './wallet.service';
import { RevenueSplitService } from './revenue-split.service';
import { CoinPurchaseService, PAYMENT_PROVIDER } from './coin-purchase.service';
import { GiftService } from './gift.service';
import { ChargebackService } from './chargeback.service';
import { WalletController, CoinPurchaseController, GiftController } from './economy.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { MockPaymentProvider, UnavailablePaymentProvider } from './providers/payment-provider.interface';
import { isProduction } from '../common/provider-mode';
import { PaystackPaymentProvider } from './providers/paystack-payment-provider';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HostLevelsModule } from '../host-levels/host-levels.module';

const logger = new Logger('EconomyModule');

@Module({
  imports: [ConfigModule, RealtimeModule, NotificationsModule, HostLevelsModule],
  providers: [CoinPackageAdminService, GiftAdminService, 
    WalletService,
    RevenueSplitService,
    CoinPurchaseService,
    GiftService,
    ChargebackService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) => {
        if (config.get<string>('PAYSTACK_SECRET_KEY')) {
          return new PaystackPaymentProvider(config, prisma);
        }
        // In production a missing key must never fall back to a provider that
        // reports every payment as successful — every payment call fails with
        // a 503 instead.
        if (isProduction(config.get<string>('NODE_ENV'))) {
          logger.error('PAYSTACK_SECRET_KEY is not set — coin purchases are DISABLED (503) until it is configured.');
          return new UnavailablePaymentProvider();
        }
        // Development only. Loudly logged, not silent.
        logger.warn(
          'PAYSTACK_SECRET_KEY not set — falling back to MockPaymentProvider. ' +
            'Real payments will NOT work until this is configured.',
        );
        return new MockPaymentProvider();
      },
    },
  ],
  controllers: [WalletController, CoinPurchaseController, GiftController, GiftAdminController, CoinPackageAdminController, PaymentWebhookController],
  exports: [WalletService, RevenueSplitService, GiftService, ChargebackService],
})
export class EconomyModule {}
