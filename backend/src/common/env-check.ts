// Checked once at startup so a missing setting is named in the first lines of the
// log instead of showing up later as a confusing error on the first login.
const REQUIRED = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;

// Not needed to start, but a feature is switched off or stubbed without them.
const RECOMMENDED: { name: string; effect: string }[] = [
  { name: 'REDIS_URL', effect: 'game rounds and PK countdowns will not run' },
  { name: 'AGORA_APP_ID', effect: 'live video is unavailable (503)' },
  { name: 'AGORA_APP_CERTIFICATE', effect: 'live video is unavailable (503)' },
  { name: 'PAYSTACK_SECRET_KEY', effect: 'coin purchases, bank lookups and payouts are unavailable (503)' },
  { name: 'S3_BUCKET', effect: 'video uploads are unavailable (503)' },
  { name: 'CORS_ORIGINS', effect: 'the admin dashboard cannot connect from a browser' },
];

export function checkEnv(env: Record<string, string | undefined>, production: boolean) {
  const blank = (v: string | undefined) => v === undefined || v.trim() === '';
  const missing = REQUIRED.filter((n) => blank(env[n]));
  const warnings = production ? RECOMMENDED.filter((r) => blank(env[r.name])) : [];
  return { missing, warnings };
}
