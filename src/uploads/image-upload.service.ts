import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { decodeImage } from './image-rules';

const MIME_BY_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Profile/cover images are stored in the same Cloudflare R2 bucket used by
 * the rest of Rryda's media storage. R2 is S3-compatible, so the existing
 * S3_* environment variables are used here as well.
 */
@Injectable()
export class ImageUploadService {
  private readonly logger = new Logger(ImageUploadService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  private requireNonEmpty(key: string): string {
    const value = (this.config.get<string>(key) ?? '').trim();
    if (!value) {
      throw new Error(`${key} is required for image uploads.`);
    }
    return value;
  }

  constructor(private readonly config: ConfigService) {
    this.bucket = this.requireNonEmpty('S3_BUCKET');
    this.publicBaseUrl = this.requireNonEmpty('S3_PUBLIC_BASE_URL').replace(/\/+$/, '');

    const endpoint = this.requireNonEmpty('S3_ENDPOINT');
    const region = (this.config.get<string>('S3_REGION') ?? 'auto').trim() || 'auto';

    this.s3 = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.requireNonEmpty('S3_ACCESS_KEY_ID'),
        secretAccessKey: this.requireNonEmpty('S3_SECRET_ACCESS_KEY'),
      },
      // Cloudflare R2 is S3-compatible but does not need the SDK to add
      // optional checksum headers to every request.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async upload(input: unknown): Promise<{ url: string }> {
    const { bytes, type } = decodeImage(input);
    const mime = MIME_BY_TYPE[type];
    if (!mime) throw new BadGatewayException('Unsupported image type');

    const key = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${type === 'jpeg' ? 'jpg' : type}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: mime,
        }),
      );
    } catch (err: any) {
      const name = String(err?.name ?? err?.Code ?? 'StorageError');
      const status = err?.$metadata?.httpStatusCode ?? '-';
      this.logger.warn(
        `R2 image upload failed: ${name} HTTP ${status} ${String(err?.message ?? err).slice(0, 300)}`,
      );
      throw new BadGatewayException('Image upload failed at the storage host. Please retry.');
    }

    // S3_PUBLIC_BASE_URL may be the Rryda storage proxy
    // (https://<api>/api/v1/storage/files) or a Cloudflare public/custom
    // domain. Both use the same stored object key.
    return { url: `${this.publicBaseUrl}/${key}` };
  }
}
