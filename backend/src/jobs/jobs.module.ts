import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { PkModule } from '../pk/pk.module';
import { GamesModule } from '../games/games.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { C2CModule } from '../c2c/c2c.module';

@Module({
  imports: [PkModule, GamesModule, ReconciliationModule, C2CModule],
  providers: [JobsService],
})
export class JobsModule {}
