import { Module } from '@nestjs/common';
import { FanClubsController } from './fan-clubs.controller';
import { FanClubsService } from './fan-clubs.service';
import { SupporterLevelsModule } from '../supporters/supporter-levels.module';

@Module({ imports: [SupporterLevelsModule], controllers: [FanClubsController], providers: [FanClubsService] })
export class FanClubsModule {}
