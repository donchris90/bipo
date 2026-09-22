import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationController } from './reconciliation.controller';

@Module({
  providers: [ReconciliationService],
  controllers: [ReconciliationController],
})
export class ReconciliationModule {}
