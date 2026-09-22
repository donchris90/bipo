import { JwtService } from '@nestjs/jwt';
import { checkEnv } from './env-check';
import { ACCESS_TOKEN_DEFAULT, REFRESH_TOKEN_DEFAULT, tokenLifetime } from './token-lifetime';

describe('tokenLifetime', () => {
  it('uses the default when the variable is missing, empty or blank — the case that broke login', () => {
    expect(tokenLifetime(undefined, ACCESS_TOKEN_DEFAULT)).toBe('15m');
    expect(tokenLifetime('', ACCESS_TOKEN_DEFAULT)).toBe('15m');
    expect(tokenLifetime('   ', REFRESH_TOKEN_DEFAULT)).toBe('30d');
  });

  it('accepts seconds, and s/m/h/d values, with or without quotes and case', () => {
    expect(tokenLifetime('900', '15m')).toBe('900s');
    expect(tokenLifetime('45s', '15m')).toBe('45s');
    expect(tokenLifetime('15m', '1h')).toBe('15m');
    expect(tokenLifetime('"12h"', '15m')).toBe('12h');
    expect(tokenLifetime("'30D'", '15m')).toBe('30d');
  });

  it('falls back for anything the signing library or our own parser would reject', () => {
    for (const bad of ['fifteen minutes', '15 minutes', '15x', '-5m', '0', '0m', '1.5h', '2w', 'null', 'undefined']) {
      expect(tokenLifetime(bad, '15m')).toBe('15m');
    }
  });
});

describe('checkEnv', () => {
  const ok = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b' };

  it('names every required variable that is missing or blank', () => {
    expect(checkEnv({}, true).missing).toEqual(['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']);
    expect(checkEnv({ ...ok, JWT_ACCESS_SECRET: '  ' }, true).missing).toEqual(['JWT_ACCESS_SECRET']);
    expect(checkEnv(ok, true).missing).toEqual([]);
  });

  it('in production lists the optional settings that switch features off; in development it stays quiet', () => {
    const prod = checkEnv(ok, true).warnings.map((w) => w.name);
    expect(prod).toEqual(expect.arrayContaining(['REDIS_URL', 'PAYSTACK_SECRET_KEY', 'S3_BUCKET', 'CORS_ORIGINS']));
    expect(checkEnv(ok, false).warnings).toEqual([]);
    expect(checkEnv({ ...ok, REDIS_URL: 'redis://x' }, true).warnings.map((w) => w.name)).not.toContain('REDIS_URL');
  });
});

describe('the login failure this fixes, reproduced', () => {
  const jwt = new JwtService({});

  it('the signing library refuses an undefined lifetime — which is what an unset variable produced', async () => {
    await expect(jwt.signAsync({ sub: 'u' }, { secret: 's', expiresIn: undefined })).rejects.toThrow(/expiresIn/);
  });

  it('with the default applied, signing works and the token expires in 15 minutes', async () => {
    const token = await jwt.signAsync({ sub: 'u' }, { secret: 's', expiresIn: tokenLifetime(undefined, ACCESS_TOKEN_DEFAULT) });
    const payload: any = jwt.decode(token);
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });
});
