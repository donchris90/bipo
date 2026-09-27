import { Module } from '@nestjs/common';
import { ExperienceService } from './experience.service';
import { ExperienceController } from './experience.controller';
@Module({ controllers: [ExperienceController], providers: [ExperienceService], exports: [ExperienceService] })
export class RrydaExperienceModule {}
