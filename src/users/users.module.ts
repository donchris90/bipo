import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { EconomyModule } from '../economy/economy.module';
import { HostLevelsModule } from '../host-levels/host-levels.module';
import { RrydaLevelsModule } from '../rryda-levels/rryda-levels.module';

@Module({
  imports: [EconomyModule, HostLevelsModule, RrydaLevelsModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
