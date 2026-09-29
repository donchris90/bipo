import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UploadsController } from './uploads.controller';
import { ImageUploadService } from './image-upload.service';

@Module({
  imports: [ConfigModule],
  controllers: [UploadsController],
  providers: [ImageUploadService],
  exports: [ImageUploadService],
})
export class UploadsModule {}
