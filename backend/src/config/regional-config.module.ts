import { Module } from '@nestjs/common';
import { RegionalConfigService } from './regional-config.service';
import { RegionalConfigController, PublicRegionsController } from './regional-config.controller';

@Module({
  providers: [RegionalConfigService],
  controllers: [RegionalConfigController, PublicRegionsController],
  exports: [RegionalConfigService],
})
export class RegionalConfigModule {}
