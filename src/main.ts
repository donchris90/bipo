import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ThrottlerExceptionFilter } from './common/filters/throttler-exception.filter';
import { isOriginAllowed, parseOrigins } from './common/cors';

async function bootstrap() {
  // rawBody: true makes req.rawBody (a Buffer) available alongside the
  // normal parsed JSON body — needed because Paystack (and most payment
  // providers) sign the exact raw request bytes for webhook verification.
  // Re-serializing the parsed JSON object would not reliably reproduce the
  // same bytes (key ordering, whitespace), so verifying against anything
  // other than the true raw body is not a real signature check.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  app.useGlobalFilters(new ThrottlerExceptionFilter());

  // Browsers block a web page (the admin dashboard) from calling this API unless
  // the API says it may. There was no CORS setting at all before, so the admin
  // could never connect. Set CORS_ORIGINS to the dashboard's address(es).
  const allowedOrigins = parseOrigins(process.env.CORS_ORIGINS);
  const production = process.env.NODE_ENV === 'production';
  app.enableCors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin, allowedOrigins, production)),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    maxAge: 86400,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields — clients cannot inject unexpected data (e.g. a balance field)
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Nest's default JSON limit (100 kb) is too small for a base64 image
  // upload (POST /uploads/image, up to 5 MB decoded = ~6.7 MB encoded). The
  // upload route is rate-limited and size-checked before decoding, but this
  // limit is global — see the uploads controller for the per-route guards.
  // 12 MB also covers an identity check (POST /kyc: an ID photo and a selfie, up
  // to 3 MB each, base64-encoded), which is rate-limited to 5 per 10 minutes.
  app.useBodyParser('json', { limit: '12mb' });

  // Rate limits count per client IP on the unauthenticated routes (login,
  // register). Behind a reverse proxy / load balancer every request arrives
  // from the proxy's address unless Express is told to trust the
  // X-Forwarded-For header — and then all users share ONE login limit.
  // Set TRUST_PROXY to the number of proxies in front of the app (usually 1),
  // or to an Express trust-proxy value. Leave unset when clients connect
  // directly, since trusting the header there would let anyone spoof their IP.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  }

  app.enableCors(); // tighten to an explicit allowlist before production

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Platform backend listening on port ${port}`);
}
bootstrap();
