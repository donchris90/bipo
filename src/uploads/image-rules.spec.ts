import { BadRequestException } from '@nestjs/common';
import { MAX_IMAGE_BYTES, decodeImage, detectImageType } from './image-rules';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

describe('detectImageType', () => {
  it('identifies each supported format from its magic bytes', () => {
    expect(detectImageType(JPEG)).toBe('jpeg');
    expect(detectImageType(PNG)).toBe('png');
    expect(detectImageType(GIF)).toBe('gif');
    expect(detectImageType(WEBP)).toBe('webp');
  });

  it('rejects anything else, including executables and truncated data', () => {
    expect(detectImageType(Buffer.from('MZ\x90\x00'))).toBeNull(); // Windows exe
    expect(detectImageType(Buffer.from('<svg xmlns=...>'))).toBeNull(); // SVG can carry script
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('decodeImage', () => {
  it('accepts plain base64 and data URIs', () => {
    const b64 = PNG.toString('base64');
    expect(decodeImage(b64).type).toBe('png');
    expect(decodeImage(`data:image/png;base64,${b64}`).type).toBe('png');
  });

  it('rejects missing, non-string, and malformed input', () => {
    expect(() => decodeImage(undefined)).toThrow(BadRequestException);
    expect(() => decodeImage('')).toThrow(BadRequestException);
    expect(() => decodeImage(42)).toThrow(BadRequestException);
    expect(() => decodeImage('not base64 !!!')).toThrow(BadRequestException);
  });

  it('rejects a real file that is not an image, even if it is valid base64', () => {
    expect(() => decodeImage(Buffer.from('MZ\x90\x00\x03').toString('base64'))).toThrow(BadRequestException);
  });

  it('refuses an oversized payload from its encoded length', () => {
    const tooBig = 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 1024) * 4) / 3));
    expect(() => decodeImage(tooBig)).toThrow(/too large/);
  });
});
