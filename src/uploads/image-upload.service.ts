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

@Injectable()
export class ImageUploadService {
  private readonly logger = new Logger(ImageUploadService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    // Custom domain or CDN URL images are served from publicly (e.g.
    // https://cdn.yourapp.com) — NOT S3_ENDPOINT, which is the API
    // endpoint used to talk to the storage host, not a public URL.
    this.publicBaseUrl = this.config.getOrThrow<string>('S3_PUBLIC_BASE_URL').replace(/\/+$/, '');

    this.s3 = new S3Client({
      region: this.config.getOrThrow<string>('S3_REGION'),
      endpoint: this.config.getOrThrow<string>('S3_ENDPOINT'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
      },
    });
  }

  /**
   * Takes whatever the client sent (plain base64 or a data: URI — see
   * decodeImage) and returns a publicly-viewable URL, same contract the
   * old ImgBB-backed version had. Validation (size limit, format
   * allowlist via magic-byte sniffing) is delegated to image-rules.ts,
   * which is already unit-tested — this service only owns the upload.
   */
  async uploadBase64(input: unknown): Promise<string> {
    const { bytes, type } = decodeImage(input);
    const key = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${type === 'jpeg' ? 'jpg' : type}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: MIME_BY_TYPE[type],
          // R2 doesn't use ACLs the way S3 does — public access is granted
          // at the bucket/custom-domain level in the dashboard, not per
          // object, so no ACL field is set here.
        }),
      );
    } catch (err) {
      this.logger.warn(`Storage host rejected the upload: ${(err as Error).message}`);
      throw new BadGatewayException('Image upload failed at the storage host. Please retry.');
    }

    return `${this.publicBaseUrl}/${key}`;
  }
}
