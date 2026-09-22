import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { PkModule } from '../pk/pk.module';
import { GamesModule } from '../games/games.module';

@Module({
  imports: [PkModule, GamesModule],
  providers: [JobsService],
})
export class JobsModule {}
