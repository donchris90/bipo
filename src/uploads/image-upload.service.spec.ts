import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageUploadService } from './image-upload.service';

describe('ImageUploadService', () => {
  it('does not depend on S3 endpoint configuration', async () => {
    const config = new ConfigService({ IMGBB_API_KEY: 'test-key', S3_ENDPOINT: '' });
    const service = new ImageUploadService(config);
    expect(service).toBeDefined();
  });

  it('reports missing image-provider configuration clearly', async () => {
    const config = new ConfigService({ IMGBB_API_KEY: '' });
    const service = new ImageUploadService(config);
    await expect(service.upload('not-base64')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
