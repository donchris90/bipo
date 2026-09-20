import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PayoutsModule } from '../payouts/payouts.module';

@Module({
  imports: [PayoutsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
