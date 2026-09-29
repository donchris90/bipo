import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { decodeImage } from './image-rules';

const MIME_BY_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Profile/cover images use the dedicated image provider, independently from
 * the S3 video-storage configuration. This is intentional: a missing video
 * bucket endpoint must never make avatar uploads fail.
 */
@Injectable()
export class ImageUploadService {
  private readonly logger = new Logger(ImageUploadService.name);
  private readonly imgbbKey: string;

  constructor(private readonly config: ConfigService) {
    this.imgbbKey = (this.config.get<string>('IMGBB_API_KEY') ?? '').trim();
  }

  async upload(input: unknown): Promise<string> {
    if (!this.imgbbKey) {
      throw new ServiceUnavailableException('Image uploads are not configured on the server. Set IMGBB_API_KEY and redeploy.');
    }

    const { base64, type } = decodeImage(input);
    const mime = MIME_BY_TYPE[type];
    if (!mime) throw new BadGatewayException('Unsupported image type');

    try {
      // ImgBB accepts the raw base64 payload as form data. Keeping the key on
      // the server prevents it from being extracted from the mobile APK.
      const body = new URLSearchParams();
      body.set('key', this.imgbbKey);
      body.set('image', base64);
      body.set('name', randomUUID());

      const response = await fetch('https://api.imgbb.com/1/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const payload = (await response.json().catch(() => null)) as any;
      if (!response.ok || !payload?.success || !payload?.data?.url) {
        this.logger.warn(`Image provider rejected upload: HTTP ${response.status}`);
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      }

      return String(payload.data.url);
    } catch (error: any) {
      this.logger.warn(`Image upload failed: ${String(error?.message ?? error).slice(0, 300)}`);
      throw new BadGatewayException('Image upload failed. Please retry.');
    }
  }
}
