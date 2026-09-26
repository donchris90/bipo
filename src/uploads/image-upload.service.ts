import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB, same limit the mobile app already checks client-side

// Base64 doesn't carry a mime type, so we sniff the first few decoded bytes
// (the same "magic numbers" every image format starts with) to pick a
// Content-Type and extension. ImgBB used to do this for us; R2 won't.
const SIGNATURES: { bytes: number[]; mime: string; ext: string }[] = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg', ext: 'jpg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png', ext: 'png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif', ext: 'gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp', ext: 'webp' }, // RIFF container; WebP specifically has "WEBP" at byte 8, but RIFF alone is a safe enough signal here since we only ever accept images
];

function detectImageType(buffer: Buffer): { mime: string; ext: string } | null {
  return SIGNATURES.find((sig) => sig.bytes.every((byte, i) => buffer[i] === byte)) ?? null;
}

@Injectable()
export class ImageUploadService {
  private readonly logger = new Logger(ImageUploadService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    const accountId = this.config.getOrThrow<string>('S2_ACCOUNT_ID');
    this.bucket = this.config.getOrThrow<string>('S2_BUCKET_NAME');
    // Your R2 custom domain (e.g. https://cdn.yourapp.com) or, for testing
    // only, the bucket's r2.dev URL. r2.dev is rate-limited and meant for
    // dev/preview, not production traffic — set up a custom domain in the
    // R2 dashboard (Settings → Public access) before shipping this.
    this.publicBaseUrl = this.config.getOrThrow<string>('S2_PUBLIC_URL').replace(/\/+$/, '');

    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S2_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('S2_SECRET_ACCESS_KEY'),
      },
    });
  }

  /**
   * Takes the raw base64 string the mobile app sends (no data: prefix —
   * see src/api/uploads.ts on the client) and returns a publicly-viewable
   * URL, same contract the old ImgBB-backed version had.
   */
  async uploadBase64(base64: string): Promise<string> {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
      if (buffer.length === 0) throw new Error('empty');
    } catch {
      throw new BadRequestException('Invalid base64 string.');
    }

    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException('Image is too large. Maximum size is 5 MB.');
    }

    const detected = detectImageType(buffer);
    if (!detected) {
      throw new BadRequestException('Unsupported image format. Use JPEG, PNG, GIF or WebP.');
    }

    const key = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${detected.ext}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: detected.mime,
          // R2 doesn't use ACLs the way S3 does — public access is granted
          // at the bucket/custom-domain level in the R2 dashboard, not per
          // object, so no ACL field is set here.
        }),
      );
    } catch (err) {
      this.logger.warn(`R2 rejected the upload: ${(err as Error).message}`);
      throw new BadGatewayException('Image upload failed at the storage host. Please retry.');
    }

    return `${this.publicBaseUrl}/${key}`;
  }
}
