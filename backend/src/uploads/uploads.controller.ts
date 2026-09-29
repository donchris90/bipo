import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ImageUploadService } from './image-upload.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('api/v1/uploads')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class UploadsController {
  constructor(private readonly images: ImageUploadService) {}

  // Body: { base64: string } — plain base64 or a data URI, JPEG/PNG/GIF/WebP,
  // up to 5 MB decoded. Returns { url }. Images are stored in Cloudflare R2
  // using the server-side S3_* credentials; no storage credentials reach mobile.
  @Post('image')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  image(@Body('base64') base64: string) {
    return this.images.upload(base64);
  }
}
