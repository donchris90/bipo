import { GamesReadinessService } from './games-readiness';
import { Module } from '@nestjs/common';
import { RngService } from './rng.service';
import { RoundService } from './round.service';
import { EntryService } from './entry.service';
import { SettlementService } from './settlement.service';
import { CrashService } from './crash.service';
import { GameAdminService } from './game-admin.service';
import { RoundSchedulerService } from './round-scheduler.service';
import { GamesController, GameOperatorController } from './games.controller';
import { EconomyModule } from '../economy/economy.module';
import { RegionalConfigModule } from '../config/regional-config.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

@Module({
  imports: [EconomyModule, RegionalConfigModule, FeatureFlagsModule],
  providers: [RngService, RoundService, EntryService, SettlementService, CrashService, GameAdminService, RoundSchedulerService, GamesReadinessService],
  controllers: [GamesController, GameOperatorController],
  exports: [RoundService, SettlementService, CrashService],
})
export class GamesModule {}
