import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PayoutsModule } from '../payouts/payouts.module';
import { VideosModule } from '../videos/videos.module';
import { EconomyModule } from '../economy/economy.module';

@Module({
  imports: [PayoutsModule, VideosModule, EconomyModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
