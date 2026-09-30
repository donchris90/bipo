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
import { RealtimeModule } from '../realtime/realtime.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LudoService } from './ludo.service';
import { LudoController } from './ludo.controller';
import { LudoGateway } from './ludo.gateway';
import { SeasonsModule } from '../seasons/seasons.module';
import { AyoService } from './ayo.service';
import { AyoController } from './ayo.controller';
import { AyoGateway } from './ayo.gateway';

@Module({
  imports: [EconomyModule, SeasonsModule, RealtimeModule, RegionalConfigModule, FeatureFlagsModule, ConfigModule, JwtModule.registerAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_ACCESS_SECRET') }) })],
  providers: [RngService, RoundService, EntryService, SettlementService, CrashService, GameAdminService, RoundSchedulerService, GamesReadinessService, LudoService, LudoGateway, AyoService, AyoGateway],
  controllers: [GamesController, GameOperatorController, LudoController, AyoController],
  exports: [RoundService, SettlementService, CrashService, LudoService],
})
export class GamesModule {}
