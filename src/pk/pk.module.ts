import { Module } from '@nestjs/common';
import { PkService } from './pk.service';
import { PkController } from './pk.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RrydaExperienceModule } from '../experience/experience.module';
import { SeasonsModule } from '../seasons/seasons.module';
import { WalletModule } from '../economy/wallet.module';

@Module({
  // SeasonsModule was previously imported above but never added here — meaning SeasonsService was
  // never actually provided via DI, and because it's @Optional() in PkService's constructor, that
  // failed completely silently: no crash, no log, PK battles just never contributed Season points
  // despite the code being written to do exactly that. Fixed as part of this change.
  imports: [RealtimeModule, NotificationsModule, RrydaExperienceModule, SeasonsModule, WalletModule],
  providers: [PkService],
  controllers: [PkController],
  exports: [PkService],
})
export class PkModule {}
