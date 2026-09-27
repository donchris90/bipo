import { Module } from '@nestjs/common';
import { SeasonsService } from './seasons.service';
import { SeasonsController, AdminSeasonsController } from './seasons.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { EconomyModule } from '../economy/economy.module';

// SeasonsService needs WalletService (for settlement payouts), so — unlike TeamsModule/
// RrydaLevelsModule, which only ever need NotificationsModule — this imports EconomyModule too.
// EconomyModule does not import SeasonsModule anywhere, so this stays a plain import, no forwardRef.
@Module({
  imports: [NotificationsModule, EconomyModule],
  controllers: [SeasonsController, AdminSeasonsController],
  providers: [SeasonsService],
  exports: [SeasonsService],
})
export class SeasonsModule {}
