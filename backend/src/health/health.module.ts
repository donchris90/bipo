import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VideosModule } from '../videos/videos.module';
import { HealthController } from './health.controller';

@Module({ imports: [ConfigModule, VideosModule], controllers: [HealthController] })
export class HealthModule {}
