import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UploadsController } from './uploads.controller';
import { ImageUploadService } from './image-upload.service';

@Module({
  imports: [ConfigModule],
  providers: [ImageUploadService],
  controllers: [UploadsController],
})
export class UploadsModule {}
