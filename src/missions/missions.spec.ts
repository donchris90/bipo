import { missionPeriod } from './missions.service';

describe('missionPeriod', () => {
  it('bounds the day in the configured timezone (UTC+1 default)', () => {
    // 2026-09-19 23:30 UTC is already 00:30 on the 20th in UTC+1.
    const p = missionPeriod(new Date('2026-09-19T23:30:00Z'), 60);
    expect(p.key).toBe('2026-09-20');
    expect(p.start.toISOString()).toBe('2026-09-19T23:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-09-20T23:00:00.000Z');
  });

  it('keeps a mid-day instant on its own day', () => {
    const p = missionPeriod(new Date('2026-09-19T12:00:00Z'), 60);
    expect(p.key).toBe('2026-09-19');
    expect(p.start.toISOString()).toBe('2026-09-18T23:00:00.000Z');
  });

  it('resets exactly at the local midnight boundary', () => {
    const justBefore = missionPeriod(new Date('2026-09-19T22:59:59Z'), 60);
    const atBoundary = missionPeriod(new Date('2026-09-19T23:00:00Z'), 60);
    expect(justBefore.key).toBe('2026-09-19');
    expect(atBoundary.key).toBe('2026-09-20');
  });

  it('supports a zero offset (plain UTC days) and crosses month ends', () => {
    const p = missionPeriod(new Date('2026-09-30T23:59:59Z'), 0);
    expect(p.key).toBe('2026-09-30');
    expect(p.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('is always exactly 24 hours long', () => {
    const p = missionPeriod(new Date('2026-03-29T10:00:00Z'), 60);
    expect(p.end.getTime() - p.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
