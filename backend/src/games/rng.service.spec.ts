import { RngService } from './rng.service';

describe('RngService', () => {
  const rng = new RngService();

  it('randomInRange never produces a value outside [min, max]', () => {
    for (let i = 0; i < 2000; i++) {
      const value = rng.randomInRange(1, 30);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(30);
    }
  });

  it('randomInRange covers the full range given enough draws (not stuck at one end)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(rng.randomInRange(1, 10));
    expect(seen.size).toBe(10);
  });

  it('commitmentHash is deterministic for the same secret + round data', () => {
    const a = rng.commitmentHash('secret-1', 'round-data');
    const b = rng.commitmentHash('secret-1', 'round-data');
    expect(a).toBe(b);
  });

  it('commitmentHash changes if the secret changes (can\'t be forged after the fact)', () => {
    const a = rng.commitmentHash('secret-1', 'round-data');
    const b = rng.commitmentHash('secret-2', 'round-data');
    expect(a).not.toBe(b);
  });

  it('generateSecret produces distinct values', () => {
    const secrets = new Set(Array.from({ length: 100 }, () => rng.generateSecret()));
    expect(secrets.size).toBe(100);
  });
});
