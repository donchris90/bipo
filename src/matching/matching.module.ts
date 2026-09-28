import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MatchingController } from './matching.controller';
import { LiveModule } from '../live/live.module';
import { RealtimeModule } from '../realtime/realtime.module';

// LiveModule exports RTC_PROVIDER (the same Agora provider Calls/Rooms use); RealtimeModule
// exports the socket gateway. Nothing imports MatchingModule except AppModule, so it adds no
// cycle to the module graph.
@Module({
  imports: [LiveModule, RealtimeModule],
  controllers: [MatchingController],
  providers: [MatchingService],
})
export class MatchingModule {}
