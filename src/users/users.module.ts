import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { EconomyModule } from '../economy/economy.module';
import { ReferralConfigModule } from '../referral-config/referral-config.module';
import { HostLevelsModule } from '../host-levels/host-levels.module';
import { RrydaLevelsModule } from '../rryda-levels/rryda-levels.module';
import { TeamsModule } from '../teams/teams.module';
import { SeasonsModule } from '../seasons/seasons.module';

@Module({
  imports: [EconomyModule, ReferralConfigModule, HostLevelsModule, RrydaLevelsModule, TeamsModule, SeasonsModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
