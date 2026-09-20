import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { STORAGE_PROVIDER, type StorageProvider } from './providers/storage-provider.interface';
import { isServableKey, parseByteRange } from './storage-range';

// Serves published videos (and thumbnails) from the bucket through this API, so
// the bucket can stay private and S3_PUBLIC_BASE_URL can simply be
//   https://<your-api>/api/v1/storage/files
// Supports HTTP Range, which video players need to start and to seek.
//
// Note the trade-off: every playback streams through this server. That is fine
// to start with; for real traffic put a CDN in front of the bucket (Cloudflare R2
// public bucket + custom domain) and point S3_PUBLIC_BASE_URL at that instead.
@Controller('api/v1/storage')
export class StorageController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  @Get('files/*')
  async file(@Req() req: Request, @Res() res: Response) {
    const key = (req.params as Record<string, string>)[0];
    if (!isServableKey(key) || !this.storage.readObject) {
      res.status(404).json({ statusCode: 404, message: 'Not found' });
      return;
    }
    let out;
    try {
      out = await this.storage.readObject(key, parseByteRange(req.headers.range) ?? undefined);
    } catch (e: any) {
      const status = e?.getStatus?.() ?? 502;
      res.status(status).json({ statusCode: status, message: status === 503 ? e.message : 'Could not read that file' });
      return;
    }
    if (!out) {
      res.status(404).json({ statusCode: 404, message: 'Not found' });
      return;
    }
    res.status(out.partial ? 206 : 200);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    // Keys contain a random id and are never overwritten, so they can be cached hard.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (out.contentLength !== null) res.setHeader('Content-Length', String(out.contentLength));
    if (out.contentRange) res.setHeader('Content-Range', out.contentRange);
    out.body.on('error', () => res.destroy());
    out.body.pipe(res);
  }
}
