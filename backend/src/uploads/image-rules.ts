import { BadRequestException } from '@nestjs/common';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // decoded size

export type ImageType = 'jpeg' | 'png' | 'gif' | 'webp';

// The client says what it is uploading; the bytes say what it actually is.
// Identified from the file's magic numbers so the endpoint can't be used to
// push arbitrary files through to the image host.
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

// Accepts plain base64 or a data URI, returns the decoded bytes, or throws a
// 400. The size is checked from the encoded length BEFORE decoding, so an
// oversized payload is refused without allocating it.
export function decodeImage(input: unknown): { bytes: Buffer; base64: string; type: ImageType } {
  if (typeof input !== 'string' || input.length === 0) throw new BadRequestException('base64 image data is required');

  const base64 = input.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new BadRequestException('Image data is not valid base64');

  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new BadRequestException(`Image is too large (limit ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB)`);
  }

  const bytes = Buffer.from(base64, 'base64');
  const type = detectImageType(bytes);
  if (!type) throw new BadRequestException('Unsupported image (use JPEG, PNG, GIF or WebP)');
  return { bytes, base64, type };
}
