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
import { NowPaymentsPaymentProvider } from './providers/nowpayments-payment-provider';
import { PaymentProviderRouter } from './providers/payment-provider-router';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

const logger = new Logger('EconomyModule');

@Module({
  imports: [ConfigModule, RealtimeModule, NotificationsModule],
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
        const paystack = new PaystackPaymentProvider(config, prisma);
        const crypto = new NowPaymentsPaymentProvider(config);
        if (config.get<string>('PAYSTACK_SECRET_KEY') || config.get<string>('NOWPAYMENTS_API_KEY')) {
          return new PaymentProviderRouter(paystack, crypto);
        }
        if (isProduction(config.get<string>('NODE_ENV'))) {
          logger.error('No real payment provider is configured — coin purchases are DISABLED (503) until one is configured.');
          return new UnavailablePaymentProvider();
        }
        logger.warn('No real payment key configured — development may use MockPaymentProvider only.');
        return new MockPaymentProvider();
      },
    },
  ],
  controllers: [WalletController, CoinPurchaseController, GiftController, GiftAdminController, CoinPackageAdminController, PaymentWebhookController],
  exports: [WalletService, RevenueSplitService, GiftService, ChargebackService],
})
export class EconomyModule {}
