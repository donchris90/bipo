import { Module, forwardRef } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { ModerationController } from './moderation.controller';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [forwardRef(() => RealtimeModule)],
  controllers: [ModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
