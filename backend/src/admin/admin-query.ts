import { BadRequestException } from '@nestjs/common';

// Small pure helpers shared by the admin list endpoints, kept apart from the
// service so the parsing rules have direct tests.

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export function clampLimit(raw: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_PAGE_SIZE);
}

// `before` is the createdAt (ISO) of the last row the client already has.
export function parseBefore(raw: unknown): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) throw new BadRequestException('before must be an ISO timestamp');
  return date;
}

// Accepts only values from `allowed` (case-insensitive) or "ALL"/empty (= no
// filter, returned as undefined). Anything else is a 400 rather than being
// passed to the database.
export function parseEnumFilter<T extends string>(raw: unknown, allowed: readonly T[], fallback?: T): T | undefined {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).toUpperCase();
  if (value === 'ALL') return undefined;
  const match = allowed.find((a) => a === value);
  if (!match) throw new BadRequestException(`must be one of: ${allowed.join(', ')}, ALL`);
  return match;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Free-text user search: matches email or display name (case-insensitive,
// substring), or an exact id when the text is a UUID.
export function userSearchWhere(search: unknown) {
  const term = typeof search === 'string' ? search.trim() : '';
  if (!term) return {};
  const or: Record<string, unknown>[] = [
    { email: { contains: term, mode: 'insensitive' } },
    { displayName: { contains: term, mode: 'insensitive' } },
  ];
  if (UUID_RE.test(term)) or.push({ id: term });
  return { OR: or };
}
