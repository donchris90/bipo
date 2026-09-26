import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MissionsService } from './missions.service';
import { MissionsController } from './missions.controller';
import { EconomyModule } from '../economy/economy.module';
import { RrydaLevelsModule } from '../rryda-levels/rryda-levels.module';
import { BadgesModule } from '../badges/badges.module';

@Module({
  imports: [ConfigModule, EconomyModule, RrydaLevelsModule, BadgesModule],
  providers: [MissionsService],
  controllers: [MissionsController],
})
export class MissionsModule {}
