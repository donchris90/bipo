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
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LudoService } from './ludo.service';
import { LudoController } from './ludo.controller';
import { LudoGateway } from './ludo.gateway';

@Module({
  imports: [EconomyModule, RegionalConfigModule, FeatureFlagsModule, ConfigModule, JwtModule.registerAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_ACCESS_SECRET') }) })],
  providers: [RngService, RoundService, EntryService, SettlementService, CrashService, GameAdminService, RoundSchedulerService, GamesReadinessService, LudoService, LudoGateway],
  controllers: [GamesController, GameOperatorController, LudoController],
  exports: [RoundService, SettlementService, CrashService, LudoService],
})
export class GamesModule {}
