import { Module } from '@nestjs/common';
import { SeasonsService } from './seasons.service';
import { SeasonAutoSettleService } from './season-auto-settle.service';
import { SeasonAutoStartService } from './season-auto-start.service';
import { SeasonsController, AdminSeasonsController } from './seasons.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../economy/wallet.module';

// SeasonsService needs WalletService (for settlement payouts), so — unlike TeamsModule/
// RrydaLevelsModule, which only ever need NotificationsModule — this also imports WalletModule.
// Deliberately WalletModule, not all of EconomyModule: EconomyModule now imports SeasonsModule
// too (GiftService's gift-sending-contributes-season-points hook), so importing EconomyModule
// here would be a real cycle. WalletModule imports nothing, so both sides stay plain imports,
// no forwardRef — see WalletModule's header comment. SeasonAutoStartService needs PushService,
// which comes from NotificationsModule (already imported above).
@Module({
  imports: [NotificationsModule, WalletModule],
  controllers: [SeasonsController, AdminSeasonsController],
  providers: [SeasonsService, SeasonAutoSettleService, SeasonAutoStartService],
  exports: [SeasonsService],
})
export class SeasonsModule {}
