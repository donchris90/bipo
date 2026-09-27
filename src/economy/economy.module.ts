import { CoinPackageAdminService } from './coin-package-admin.service';
import { CoinPackageAdminController } from './coin-package-admin.controller';
import { GiftAdminController } from './gift-admin.controller';
import { GiftAdminService } from './gift-admin';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WalletModule } from './wallet.module';
import { RevenueSplitService } from './revenue-split.service';
import { CoinPurchaseService, PAYMENT_PROVIDER } from './coin-purchase.service';
import { GiftService } from './gift.service';
import { GifterService } from './gifter.service';
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
import { RrydaLevelsModule } from '../rryda-levels/rryda-levels.module';
import { SupporterLevelsModule } from '../supporters/supporter-levels.module';
import { RoomCommunityModule } from '../rooms/room-community.module';
import { TeamsModule } from '../teams/teams.module';
import { SeasonsModule } from '../seasons/seasons.module';

const logger = new Logger('EconomyModule');

// SeasonsModule is here (unlike TeamsModule/RoomCommunityModule/etc., which SeasonsModule has no
// reason to import back) so that GiftService can award season points on a sent gift. This works
// as a plain import — no forwardRef — only because SeasonsModule was moved onto WalletModule
// instead of all of EconomyModule; see WalletModule's header comment for the full reasoning.
@Module({
  imports: [
    ConfigModule,
    RealtimeModule,
    NotificationsModule,
    HostLevelsModule,
    RrydaLevelsModule,
    SupporterLevelsModule,
    RoomCommunityModule,
    TeamsModule,
    WalletModule,
    SeasonsModule,
  ],
  providers: [CoinPackageAdminService, GiftAdminService,
    RevenueSplitService,
    CoinPurchaseService,
    GiftService,
    GifterService,
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
  // WalletModule re-exported (not just its own WalletService) so every existing consumer that
  // imports EconomyModule to get WalletService keeps working unchanged.
  exports: [WalletModule, RevenueSplitService, GiftService, GifterService, ChargebackService],
})
export class EconomyModule {}
