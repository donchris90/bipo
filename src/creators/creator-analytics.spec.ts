import { BadRequestException } from '@nestjs/common';
import { overlapSeconds, parsePeriod, periodStart } from './creator-analytics.service';

describe('overlapSeconds', () => {
  const windowStart = new Date('2026-09-10T00:00:00Z');
  const windowEnd = new Date('2026-09-11T00:00:00Z');

  it('counts a session fully inside the window in full', () => {
    expect(overlapSeconds(new Date('2026-09-10T10:00:00Z'), new Date('2026-09-10T11:30:00Z'), windowStart, windowEnd)).toBe(
      5400,
    );
  });

  it('clips a session that began before the window to the part inside it', () => {
    expect(overlapSeconds(new Date('2026-09-09T23:00:00Z'), new Date('2026-09-10T01:00:00Z'), windowStart, windowEnd)).toBe(
      3600,
    );
  });

  it('clips a session that is still running past the window end', () => {
    expect(overlapSeconds(new Date('2026-09-10T23:00:00Z'), new Date('2026-09-11T05:00:00Z'), windowStart, windowEnd)).toBe(
      3600,
    );
  });

  it('is zero for a session entirely outside the window', () => {
    expect(overlapSeconds(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'), windowStart, windowEnd)).toBe(
      0,
    );
  });
});

describe('periodStart', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');

  it('uses rolling lookbacks', () => {
    expect(periodStart('today', now).toISOString()).toBe('2026-09-18T12:00:00.000Z');
    expect(periodStart('week', now).toISOString()).toBe('2026-09-12T12:00:00.000Z');
    expect(periodStart('month', now).toISOString()).toBe('2026-08-20T12:00:00.000Z');
  });

  it("'all' starts at the epoch", () => {
    expect(periodStart('all', now).getTime()).toBe(0);
  });
});

describe('parsePeriod', () => {
  it('defaults when absent and accepts the known periods', () => {
    expect(parsePeriod(undefined)).toBe('week');
    expect(parsePeriod(undefined, 'today')).toBe('today');
    expect(parsePeriod('month')).toBe('month');
  });

  it('rejects anything else', () => {
    expect(() => parsePeriod('yesterday')).toThrow(BadRequestException);
  });
});
