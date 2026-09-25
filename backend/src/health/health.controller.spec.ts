import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports a healthy database', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as any;
    const result = await new HealthController(prisma).check();
    expect(result.status).toBe('ok');
    expect(result.database).toBe('ok');
    expect(result.timestamp).toEqual(expect.any(String));
  });

  it('returns service unavailable when the database cannot be reached', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('down')) } as any;
    await expect(new HealthController(prisma).check()).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ status: 'degraded', database: 'unavailable' }),
    });
  });
});
