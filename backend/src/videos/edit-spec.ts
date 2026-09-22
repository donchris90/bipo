import { BadRequestException } from '@nestjs/common';

// What a creator can do to a video in the editor, and the rules that keep it safe.
// Everything is an allow-list with bounds: the server renders exactly this and
// nothing a client makes up.

export const EDIT_FILTERS = ['none', 'vivid', 'warm', 'cool', 'mono', 'vintage', 'fade', 'dramatic'] as const;
export const EDIT_EFFECTS = ['none', 'vignette', 'grain', 'pulse', 'sharpen', 'glow'] as const;
export const EDIT_SPEEDS = [0.5, 1, 1.5, 2] as const;
export type EditFilter = (typeof EDIT_FILTERS)[number];
export type EditEffect = (typeof EDIT_EFFECTS)[number];

export const MAX_OUTPUT_SECONDS = 180;
export const MAX_SOURCE_SECONDS = 600;
export const MIN_CLIP_MS = 1000;
export const MAX_OVERLAY_BYTES = 5 * 1024 * 1024;
export const MAX_MUSIC_BYTES = 30 * 1024 * 1024;

export interface CleanEditSpec {
  trim: { startMs: number; endMs: number } | null;
  speed: 0.5 | 1 | 1.5 | 2;
  filter: EditFilter;
  effect: EditEffect;
  music: { volumeOriginal: number; volumeMusic: number; startMs: number };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

export function cleanEditSpec(raw: any): CleanEditSpec {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('spec must be an object');
  const errors: string[] = [];

  let trim: CleanEditSpec['trim'] = null;
  if (raw.trim !== undefined && raw.trim !== null) {
    const start = num(raw.trim.startMs);
    const end = num(raw.trim.endMs);
    if (!(start >= 0) || !(end >= 0) || !Number.isInteger(start) || !Number.isInteger(end)) errors.push('trim start and end must be whole numbers of milliseconds');
    else if (end - start < MIN_CLIP_MS) errors.push('the trimmed video must be at least 1 second long');
    else if (end - start > MAX_SOURCE_SECONDS * 1000) errors.push('the trimmed video is too long');
    else trim = { startMs: start, endMs: end };
  }

  const speed = raw.speed === undefined ? 1 : raw.speed;
  if (!(EDIT_SPEEDS as readonly number[]).includes(speed)) errors.push(`speed must be one of ${EDIT_SPEEDS.join(', ')}`);

  const filter = raw.filter ?? 'none';
  if (!(EDIT_FILTERS as readonly string[]).includes(filter)) errors.push(`filter must be one of ${EDIT_FILTERS.join(', ')}`);
  const effect = raw.effect ?? 'none';
  if (!(EDIT_EFFECTS as readonly string[]).includes(effect)) errors.push(`effect must be one of ${EDIT_EFFECTS.join(', ')}`);

  const m = raw.music ?? {};
  const volumeOriginal = m.volumeOriginal === undefined ? 1 : num(m.volumeOriginal);
  const volumeMusic = m.volumeMusic === undefined ? 0.8 : num(m.volumeMusic);
  const startMs = m.startMs === undefined ? 0 : num(m.startMs);
  if (!(volumeOriginal >= 0 && volumeOriginal <= 1)) errors.push('music.volumeOriginal must be between 0 and 1');
  if (!(volumeMusic >= 0 && volumeMusic <= 1)) errors.push('music.volumeMusic must be between 0 and 1');
  if (!(startMs >= 0 && startMs <= 3_600_000)) errors.push('music.startMs is not valid');

  if (errors.length) throw new BadRequestException(errors.join('; '));
  return { trim, speed, filter, effect, music: { volumeOriginal, volumeMusic, startMs: Math.floor(startMs) } } as CleanEditSpec;
}

// ── keys: every file a job uses must be one of the caller's own uploads ──────────

export const AUDIO_CONTENT_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
};

export type EditAsset = 'overlay' | 'music';

export function editKeyFor(userId: string, uuid: string, asset: EditAsset, contentType: string): string {
  if (asset === 'overlay') {
    if (contentType !== 'image/png') throw new BadRequestException('The text and sticker layer must be a PNG');
    return `edits/${userId}/${uuid}.png`;
  }
  const ext = AUDIO_CONTENT_TYPES[contentType];
  if (!ext) throw new BadRequestException('Unsupported music type (use mp3, m4a, aac, wav or ogg)');
  return `edits/${userId}/${uuid}.${ext}`;
}

export function editKeyBelongsTo(userId: string, key: unknown, asset: EditAsset): key is string {
  if (typeof key !== 'string' || key.includes('..')) return false;
  if (!key.startsWith(`edits/${userId}/`)) return false;
  return asset === 'overlay' ? /\.png$/.test(key) : /\.(mp3|m4a|aac|wav|ogg)$/.test(key);
}

// True when nothing would change the video, so it can be published as it is.
export function isNoEdit(spec: CleanEditSpec, hasOverlay: boolean, hasMusic: boolean): boolean {
  return !spec.trim && spec.speed === 1 && spec.filter === 'none' && spec.effect === 'none' && !hasOverlay && !hasMusic;
}
