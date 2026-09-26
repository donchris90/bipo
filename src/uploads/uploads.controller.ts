import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ImageUploadService } from './image-upload.service';
// import { JwtAuthGuard } from '../auth/jwt-auth.guard'; // swap in your real guard

@Controller('uploads')
export class UploadsController {
  constructor(private readonly imageUploadService: ImageUploadService) {}

  @Post('image')
  // @UseGuards(JwtAuthGuard)
  async uploadImage(@Body('base64') base64: string): Promise<{ url: string }> {
    const url = await this.imageUploadService.uploadBase64(base64);
    return { url };
  }
}
