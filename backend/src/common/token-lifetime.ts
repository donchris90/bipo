// How long login tokens last, read from JWT_ACCESS_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN.
// The signing library REJECTS a missing or malformed value ("expiresIn should be a
// number of seconds or string representing a timespan"), which turned a variable
// that simply wasn't set on the server into "nobody can log in". A missing, empty
// or unreadable value now means the safe default, never a failed login.
//
// Accepted: 30 (seconds), 45s, 15m, 12h, 30d — optionally in quotes.
export function tokenLifetime(raw: string | undefined, fallback: string): string {
  const v = (raw ?? '').trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (/^\d+$/.test(v) && Number(v) > 0) return `${v}s`;
  if (/^\d+[smhd]$/.test(v) && Number.parseInt(v, 10) > 0) return v;
  return fallback;
}

export const ACCESS_TOKEN_DEFAULT = '15m';
export const REFRESH_TOKEN_DEFAULT = '30d';
