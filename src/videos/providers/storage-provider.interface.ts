import { notConfigured } from '../../common/provider-mode';

// Same shape as RtcProvider / PaymentProvider: the service depends only on
// this interface, and the module picks the implementation from env. Swap or
// add a provider (Cloudinary, Bunny, Mux, ...) here without touching
// VideosService.
export interface StorageProvider {
  // A short-lived URL the *client* uploads the file to directly, so video
  // bytes never pass through this server.
  createUpload(params: {
    key: string;
    contentType: string;
  }): Promise<{ uploadUrl: string; method: 'PUT'; headers: Record<string, string>; expiresInSeconds: number }>;

  // Null when nothing has been uploaded at that key (yet).
  headObject(key: string): Promise<{ sizeBytes: number } | null>;

  // The URL a viewer plays from.
  publicUrl(key: string): string;

  deleteObject(key: string): Promise<void>;

  // Streams (part of) a stored file. Used by the /storage/files route so the
  // bucket itself never has to be public. `range` is a validated HTTP byte range
  // such as "bytes=0-1023". Null when the object does not exist.
  readObject?(key: string, range?: string): Promise<ObjectRead | null>;
}

export interface ObjectRead {
  body: NodeJS.ReadableStream;
  contentType: string;
  contentLength: number | null;
  contentRange: string | null; // present when a range was served
  partial: boolean;
}

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

// Used in production when no bucket is configured: uploads and publishing fail
// with a 503 instead of accepting videos that are then thrown away.
export class UnavailableStorageProvider implements StorageProvider {
  // `reason` names what is wrong (missing variable, bad endpoint), so the 503
  // says what to fix instead of a generic "not configured".
  constructor(private readonly reason = 'set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT and S3_PUBLIC_BASE_URL') {}
  async createUpload(): Promise<never> {
    return notConfigured('Video storage', this.reason);
  }
  async headObject(): Promise<never> {
    return notConfigured('Video storage', this.reason);
  }
  publicUrl(): string {
    return '';
  }
  async deleteObject(): Promise<void> {
    /* nothing stored */
  }
  async readObject(): Promise<never> {
    return notConfigured('Video storage', this.reason);
  }
}

// Dev-only. Issues an upload URL nothing listens on and pretends every key
// exists, so the whole publish flow can be exercised without a bucket. It
// does NOT store anything — videos published against it have a URL that
// cannot be played.
export class MockStorageProvider implements StorageProvider {
  async createUpload({ key }: { key: string; contentType: string }) {
    return { uploadUrl: `mock://upload/${key}`, method: 'PUT' as const, headers: {}, expiresInSeconds: 900 };
  }

  async headObject() {
    return { sizeBytes: 1 };
  }

  publicUrl(key: string) {
    return `mock://media/${key}`;
  }

  async deleteObject() {
    /* nothing stored */
  }
}
