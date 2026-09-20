import { BadRequestException } from '@nestjs/common';

// Pure helpers, kept apart from the service so the rules that guard what
// gets stored are directly testable.

export const VIDEO_CONTENT_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export const DEFAULT_MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB

export function extensionFor(contentType: string): string {
  const ext = VIDEO_CONTENT_TYPES[contentType];
  if (!ext) throw new BadRequestException('Unsupported video type (use mp4, mov or webm)');
  return ext;
}

export function storageKeyFor(userId: string, videoUuid: string, contentType: string): string {
  return `videos/${userId}/${videoUuid}.${extensionFor(contentType)}`;
}

// A publish request may only reference a file under the caller's own prefix,
// so nobody can publish (or later delete) another user's upload by guessing
// its key.
export function keyBelongsTo(userId: string, key: string): boolean {
  return (
    typeof key === 'string' &&
    key.startsWith(`videos/${userId}/`) &&
    !key.includes('..') &&
    /\.(mp4|mov|webm)$/.test(key)
  );
}

export interface VideoMetaInput {
  title?: unknown;
  caption?: unknown;
  tag?: unknown;
}

export function cleanTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (!title) throw new BadRequestException('Title is required');
  if (title.length > 100) throw new BadRequestException('Title must be 100 characters or fewer');
  return title;
}

// Optional text: undefined = "not provided"; blank = cleared (null).
export function cleanOptionalText(raw: unknown, field: string, max: number): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new BadRequestException(`${field} must be text`);
  const text = raw.trim();
  if (text.length > max) throw new BadRequestException(`${field} must be ${max} characters or fewer`);
  return text === '' ? null : text;
}
