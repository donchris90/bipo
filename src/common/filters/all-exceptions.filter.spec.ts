import { BadRequestException, Controller, Get, INestApplication, Logger, NotFoundException } from '@nestjs/common';
import { HttpAdapterHost as CoreHttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerException } from '@nestjs/throttler';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ThrottlerExceptionFilter } from './throttler-exception.filter';

@Controller('t')
class BoomController {
  @Get('crash')
  crash() {
    throw new TypeError("Cannot read properties of undefined (reading 'x')");
  }
  @Get('missing')
  missing() {
    throw new NotFoundException('Room not found');
  }
  @Get('bad')
  bad() {
    throw new BadRequestException('nope');
  }
  @Get('slow')
  slow() {
    throw new ThrottlerException();
  }
}

// The filters are registered exactly as in main.ts.
describe('AllExceptionsFilter', () => {
  let app: INestApplication;
  let base: string;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [BoomController] }).compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(app.get(CoreHttpAdapterHost).httpAdapter), new ThrottlerExceptionFilter());
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());
  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorLog.mockRestore());

  it('an unexpected error is still a normal 500 for the client — and is logged with the route that caused it', async () => {
    const res = await fetch(`${base}/t/crash`);
    expect(res.status).toBe(500);
    expect((await res.json()).message).toBe('Internal server error');
    const lines = errorLog.mock.calls.map((c) => String(c[0]));
    const summary = lines.find((l) => l.includes('500 GET /t/crash'));
    expect(summary).toBeDefined();
    expect(summary).toContain('TypeError: Cannot read properties of undefined');
    expect(errorLog.mock.calls.some((c) => String(c[1] ?? '').includes('TypeError'))).toBe(true); // Nest still prints the stack
  });

  it('client errors (404, 400) are unchanged and are not logged as server errors', async () => {
    expect((await fetch(`${base}/t/missing`)).status).toBe(404);
    const bad = await fetch(`${base}/t/bad`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toBe('nope');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('the friendly rate-limit message still wins over the catch-all', async () => {
    const res = await fetch(`${base}/t/slow`);
    expect(res.status).toBe(429);
    expect((await res.json()).message).toMatch(/Too many requests/);
  });
});
