import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageUploadService } from './image-upload.service';

describe('ImageUploadService', () => {
  it('does not depend on S3 endpoint configuration', () => {
    const config = new ConfigService({ IMGBB_API_KEY: 'test-key', S3_ENDPOINT: '' });
    const service = new ImageUploadService(config);
    expect(service).toBeDefined();
  });

  it('reports missing image-provider configuration clearly', async () => {
    const config = new ConfigService({ IMGBB_API_KEY: '' });
    const service = new ImageUploadService(config);
    await expect(service.upload('not-base64')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns the response shape expected by the mobile client', async () => {
    const config = new ConfigService({ IMGBB_API_KEY: 'test-key' });
    const service = new ImageUploadService(config);
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: { url: 'https://example.com/image.jpg' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as Response;

    try {
      const result = await service.upload('aGVsbG8=');
      expect(result).toEqual({ url: 'https://example.com/image.jpg' });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
