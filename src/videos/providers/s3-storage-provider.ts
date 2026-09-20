import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectRead, StorageCheck, StorageProvider } from './storage-provider.interface';

const UPLOAD_URL_TTL_SECONDS = 900;

// Any S3-compatible store: AWS S3, Cloudflare R2, DigitalOcean Spaces,
// MinIO, Backblaze B2. Set S3_ENDPOINT for everything except AWS itself.
//
// Config: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
//   S3_REGION (default "auto" — what R2 expects; use e.g. "us-east-1" for AWS),
//   S3_ENDPOINT (optional), S3_PUBLIC_BASE_URL (required — the CDN / public
//   bucket URL videos are played from, e.g. https://media.example.com).
//
// Not exercised against a real bucket in this sandbox (no network to one):
// test an actual upload + playback with your credentials before relying on
// it. The bucket also needs a CORS rule allowing PUT from the app.
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string;
  private readonly endpointHost: string;

  constructor(config: ConfigService) {
    const bucket = config.get<string>('S3_BUCKET');
    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
    const publicBase = config.get<string>('S3_PUBLIC_BASE_URL');
    if (!bucket || !accessKeyId || !secretAccessKey || !publicBase) {
      throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_PUBLIC_BASE_URL must all be set');
    }
    // Cloudflare R2 and most non-AWS stores use region "auto" AND need their own
    // endpoint (R2: https://<account-id>.r2.cloudflarestorage.com). Without one the
    // SDK would call Amazon S3, which rejects the keys — say so up front.
    const region = config.get<string>('S3_REGION') ?? 'auto';
    if (region === 'auto' && !config.get<string>('S3_ENDPOINT')) {
      throw new Error('S3_ENDPOINT is required when S3_REGION is "auto" (Cloudflare R2: https://<your-account-id>.r2.cloudflarestorage.com)');
    }
    this.bucket = bucket;
    this.publicBase = publicBase.replace(/\/+$/, '');
    this.client = new S3Client({
      region: config.get<string>('S3_REGION') ?? 'auto',
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      credentials: { accessKeyId, secretAccessKey },
      // R2 / MinIO / Spaces are happiest with path-style when an endpoint is custom.
      forcePathStyle: !!config.get<string>('S3_ENDPOINT'),
      // Recent SDK versions add checksum headers to requests by default. Cloudflare R2
      // (and several other S3-compatible stores) reject them, which breaks uploads
      // and reads. Only send a checksum when an operation actually requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.endpointHost = (() => {
      try {
        return new URL(config.get<string>('S3_ENDPOINT') || 'https://s3.amazonaws.com').host;
      } catch {
        return 'invalid S3_ENDPOINT';
      }
    })();
  }

  async createUpload({ key, contentType }: { key: string; contentType: string }) {
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
    // The client must send this exact Content-Type or the signature fails.
    return {
      uploadUrl,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  async headObject(key: string) {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: Number(head.ContentLength ?? 0) };
    } catch (e: any) {
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  publicUrl(key: string) {
    return `${this.publicBase}/${key}`;
  }

  async readObject(key: string, range?: string): Promise<ObjectRead | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
      if (!out.Body) return null;
      return {
        body: out.Body as unknown as NodeJS.ReadableStream,
        contentType: out.ContentType ?? 'application/octet-stream',
        contentLength: out.ContentLength ?? null,
        contentRange: out.ContentRange ?? null,
        partial: !!out.ContentRange,
      };
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  // What an admin sees when they press "Test video storage". Names the failure and
  // what to look at, and never includes a credential.
  async check(): Promise<StorageCheck> {
    const base = { bucket: this.bucket, endpointHost: this.endpointHost };
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      return { ok: true, ...base };
    } catch (e: any) {
      const name = String(e?.name ?? e?.Code ?? e?.code ?? 'Error');
      const status = e?.$metadata?.httpStatusCode;
      const hints: Record<string, string> = {
        InvalidAccessKeyId: 'The access key id is wrong (S3_ACCESS_KEY_ID).',
        SignatureDoesNotMatch: 'The secret key is wrong (S3_SECRET_ACCESS_KEY), or has extra spaces.',
        AccessDenied: 'The credentials are valid but not allowed on this bucket: give the R2 API token "Object Read & Write" for this bucket.',
        NoSuchBucket: 'No bucket with this name at this endpoint: check S3_BUCKET and the account id in S3_ENDPOINT.',
        NotFound: 'No bucket with this name at this endpoint: check S3_BUCKET and the account id in S3_ENDPOINT.',
        ENOTFOUND: 'The endpoint address does not exist: check S3_ENDPOINT (R2: https://<account-id>.r2.cloudflarestorage.com, no bucket name on the end).',
        ECONNREFUSED: 'Could not connect to S3_ENDPOINT.',
        CERT_HAS_EXPIRED: 'The endpoint has a certificate problem: check S3_ENDPOINT.',
      };
      const hint =
        hints[name] ??
        (status === 403 ? hints.AccessDenied : status === 404 ? hints.NoSuchBucket : 'Check S3_ENDPOINT, S3_BUCKET and both keys.');
      return { ok: false, ...base, errorName: name, errorMessage: String(e?.message ?? e).slice(0, 300), hint };
    }
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
