import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { isOriginAllowed, parseOrigins } from './cors';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

// The same enableCors options main.ts uses, exercised over real HTTP with the
// preflight request a browser sends before an authenticated call.
describe('CORS over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const boot = async (env: { origins?: string; production: boolean }) => {
    const mod = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = mod.createNestApplication();
    const allowed = parseOrigins(env.origins);
    app.enableCors({
      origin: (origin, cb) => cb(null, isOriginAllowed(origin, allowed, env.production)),
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
      maxAge: 86400,
    });
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  };
  afterEach(() => app.close());

  const preflight = (origin: string) =>
    fetch(`${base}/ping`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type' } });

  it('an allowed dashboard origin passes the preflight, including the Authorization header', async () => {
    await boot({ origins: 'http://localhost:5173', production: true });
    const res = await preflight('http://localhost:5173');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('an unlisted site gets no CORS headers, so the browser blocks it', async () => {
    await boot({ origins: 'http://localhost:5173', production: true });
    const res = await preflight('https://evil.example.net');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a request with no Origin (the mobile app) is served normally', async () => {
    await boot({ production: true });
    const res = await fetch(`${base}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
