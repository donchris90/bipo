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

    // ImgBB accepts the image as a normal form field. URL-encoded requests are
    // simpler and more reliable with Node's fetch than relying on multipart
    // boundary handling through different Node/undici versions. Retry transient
    // upstream failures because a 502/503 from the image host is not the user's
    // connection failing.
    const endpoint = `https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`;
    let lastStatus = 0;
    let lastMessage = 'no detail';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const form = new URLSearchParams();
        form.set('image', base64);
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: AbortSignal.timeout(30_000),
        });
        lastStatus = response.status;
        const json: any = await response.json().catch(() => null);
        const url = json?.data?.url;
        if (response.ok && typeof url === 'string') return { url };
        lastMessage = json?.error?.message ?? 'no detail';
        // Retry only transient upstream failures. Validation/auth failures will
        // not become better on the next attempt.
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
      } catch (e: any) {
        lastMessage = e?.message ?? String(e);
        if (attempt === 2) {
          this.logger.warn(`ImgBB request failed: ${lastMessage}`);
          throw new BadGatewayException('Image host is unreachable');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }

    this.logger.warn(`ImgBB rejected the upload (${lastStatus}): ${lastMessage}`);
    throw new BadGatewayException('Image upload failed at the image host. Please retry.');
  }
}
