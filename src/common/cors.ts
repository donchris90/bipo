// Which browser origins may call this API. Browsers enforce CORS; the mobile app,
// webhooks (Paystack), curl and server-to-server calls send no Origin header and
// are never affected. The admin dashboard is a web page, so its address must be
// allowed here or every request from it fails ("Cannot reach the server").
//
// Production: ONLY the origins listed in CORS_ORIGINS (comma separated, e.g.
//   https://admin.example.com,http://localhost:5173)
// Development: those, plus localhost on any port.
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isOriginAllowed(origin: string | undefined, allowed: string[], production: boolean): boolean {
  if (!origin) return true; // not a browser: nothing to enforce
  const clean = origin.replace(/\/+$/, '');
  if (allowed.includes(clean)) return true;
  return !production && LOCALHOST_RE.test(clean);
}
