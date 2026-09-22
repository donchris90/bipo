import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ImageUploadService } from './image-upload.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('api/v1/uploads')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class UploadsController {
  constructor(private readonly images: ImageUploadService) {}

  // Body: { base64: string } — plain base64 or a data URI, JPEG/PNG/GIF/WebP,
  // up to 5 MB decoded. Returns { url }. Tightly rate-limited: an upload is
  // the most expensive thing a client can ask of this API.
  @Post('image')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  image(@Body('base64') base64: string) {
    return this.images.upload(base64);
  }
}
