import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageUploadService } from './image-upload.service';

const configValues = {
  S3_BUCKET: 'ryda',
  S3_REGION: 'auto',
  S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
  S3_PUBLIC_BASE_URL: 'https://api.example.com/api/v1/storage/files',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
};

describe('ImageUploadService', () => {
  it('uses the Cloudflare R2 S3 configuration and can be constructed', () => {
    const service = new ImageUploadService(new ConfigService(configValues));
    expect(service).toBeDefined();
  });

  it('requires a real R2 endpoint', () => {
    expect(
      () =>
        new ImageUploadService(
          new ConfigService({ ...configValues, S3_ENDPOINT: '' }),
        ),
    ).toThrow('S3_ENDPOINT is required for image uploads.');
  });

  it('uploads to R2 and returns the response shape expected by mobile', async () => {
    const service = new ImageUploadService(new ConfigService(configValues));
    const originalSend = (service as any).s3.send;
    let command: any;

    (service as any).s3.send = async (request: any) => {
      command = request;
      return {};
    };

    try {
      // Minimal valid 1x1 GIF. decodeImage validates the actual magic bytes.
      const result = await service.upload('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');

      expect(result.url).toMatch(
        /^https:\/\/api\.example\.com\/api\/v1\/storage\/files\/uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.gif$/,
      );
      expect(command.input.Bucket).toBe('ryda');
      expect(command.input.Key).toContain('uploads/');
      expect(command.input.Key).toMatch(/\.gif$/);
      expect(command.input.ContentType).toBe('image/gif');
      expect(command.input.Body).toBeInstanceOf(Buffer);
    } finally {
      (service as any).s3.send = originalSend;
    }
  });

  it('converts an R2 rejection into a controlled 502', async () => {
    const service = new ImageUploadService(new ConfigService(configValues));
    (service as any).s3.send = async () => {
      const error: any = new Error('AccessDenied');
      error.name = 'AccessDenied';
      error.$metadata = { httpStatusCode: 403 };
      throw error;
    };

    await expect(
      service.upload('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
