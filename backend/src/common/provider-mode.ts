import { ServiceUnavailableException } from '@nestjs/common';

// Anything that talks to an outside service (payments, payouts, live video,
// file storage) has a development stand-in that pretends to succeed. That is
// useful on a laptop and dangerous anywhere else: a production deployment with
// a missing or misspelled environment variable must not silently hand out
// coins nobody paid for, "pay out" money that never moved, or accept uploads
// that are thrown away. In production the stand-ins are never used; the
// provider instead answers every call with a clear 503.
export function isProduction(env: string | undefined = process.env.NODE_ENV): boolean {
  return env === 'production';
}

export function notConfigured(what: string, envHint: string): never {
  throw new ServiceUnavailableException(`${what} is not configured on this server (${envHint}).`);
}
