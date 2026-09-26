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

  // ConfigService.getOrThrow() only rejects a key that is completely UNSET (undefined) — a
  // variable that exists in .env but is left blank (`S3_ENDPOINT=`) still passes it, since ''
  // is a defined value. That let a blank S3_ENDPOINT slip through here silently: the app booted
  // fine, and every upload failed at runtime with a generic "storage host rejected it" message
  // that gave no hint the actual cause was a blank endpoint. This requires the value to be a
  // non-empty string after trimming whitespace, and fails at startup — loud and immediate,
  // naming exactly which variable is blank — instead of failing quietly per-upload later.
  private requireNonEmpty(key: string): string {
    const value = this.config.getOrThrow<string>(key).trim();
    if (!value) {
      throw new Error(`${key} is set but empty — image uploads (avatar, live cover, etc.) cannot work without a real value here.`);
    }
    return value;
  }

  constructor(private readonly config: ConfigService) {
    this.bucket = this.requireNonEmpty('S3_BUCKET');
    // Custom domain or CDN URL images are served from publicly (e.g.
    // https://cdn.yourapp.com) — NOT S3_ENDPOINT, which is the API
    // endpoint used to talk to the storage host, not a public URL.
    this.publicBaseUrl = this.requireNonEmpty('S3_PUBLIC_BASE_URL').replace(/\/+$/, '');

    this.s3 = new S3Client({
      region: this.requireNonEmpty('S3_REGION'),
      endpoint: this.requireNonEmpty('S3_ENDPOINT'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.requireNonEmpty('S3_ACCESS_KEY_ID'),
        secretAccessKey: this.requireNonEmpty('S3_SECRET_ACCESS_KEY'),
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
  async upload(input: unknown): Promise<string> {
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
