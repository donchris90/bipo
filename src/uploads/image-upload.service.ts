import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decodeImage } from './image-rules';

// Forwards an already-validated image to ImgBB using a key that lives only on
// this server (IMGBB_API_KEY). The mobile app used to carry that key in its
// bundle, where anyone could extract it from the APK; now the app only ever
// talks to this backend, behind login and a rate limit.
//
// Not exercised against ImgBB's live API in this sandbox (no network to it):
// upload a real image with your key before relying on it.
@Injectable()
export class ImageUploadService {
  private readonly logger = new Logger(ImageUploadService.name);

  constructor(private readonly config: ConfigService) {}

  async upload(base64Input: unknown): Promise<{ url: string }> {
    const key = this.config.get<string>('IMGBB_API_KEY');
    if (!key) throw new ServiceUnavailableException('Image uploads are not configured');

    const { base64 } = decodeImage(base64Input); // validates size + real image type

    const form = new FormData();
    form.append('image', base64);

    let response: Response;
    try {
      response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, { method: 'POST', body: form });
    } catch (e: any) {
      this.logger.warn(`ImgBB request failed: ${e?.message ?? e}`);
      throw new BadGatewayException('Image host is unreachable');
    }

    const json: any = await response.json().catch(() => null);
    const url = json?.data?.url;
    if (!response.ok || typeof url !== 'string') {
      // Log the host's reason; give the client a generic one (it may mention the key).
      this.logger.warn(`ImgBB rejected the upload (${response.status}): ${json?.error?.message ?? 'no detail'}`);
      throw new BadGatewayException('Image upload failed');
    }
    return { url };
  }
}
