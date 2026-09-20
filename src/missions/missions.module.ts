import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MissionsService } from './missions.service';
import { MissionsController } from './missions.controller';
import { EconomyModule } from '../economy/economy.module';

@Module({
  imports: [ConfigModule, EconomyModule],
  providers: [MissionsService],
  controllers: [MissionsController],
})
export class MissionsModule {}
