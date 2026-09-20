import { dayPeriod, monthPeriod, secondsPerDay } from './day-period';

const S = (iso: string) => new Date(iso);

describe('monthPeriod', () => {
  it('bounds the calendar month in the configured timezone', () => {
    // 2026-08-31 23:30 UTC is already September 1st in UTC+1.
    const m = monthPeriod(S('2026-08-31T23:30:00Z'), 60);
    expect(m.key).toBe('2026-09');
    expect(m.start.toISOString()).toBe('2026-08-31T23:00:00.000Z');
    expect(m.end.toISOString()).toBe('2026-09-30T23:00:00.000Z');
  });
});

describe('secondsPerDay', () => {
  const win = monthPeriod(S('2026-09-15T12:00:00Z'), 60);

  it('adds up several sessions on the same local day', () => {
    const perDay = secondsPerDay(
      [
        { start: S('2026-09-10T08:00:00Z'), end: S('2026-09-10T08:40:00Z') },
        { start: S('2026-09-10T12:00:00Z'), end: S('2026-09-10T12:30:00Z') },
      ],
      win.start,
      win.end,
      60,
    );
    expect(perDay.get('2026-09-10')).toBe(70 * 60);
  });

  it('splits a session that runs past local midnight across both days', () => {
    // 22:30 -> 00:30 UTC is 23:30 -> 01:30 local: 30 min on the 10th, 90 min on the 11th.
    const perDay = secondsPerDay([{ start: S('2026-09-10T22:30:00Z'), end: S('2026-09-11T00:30:00Z') }], win.start, win.end, 60);
    expect(perDay.get('2026-09-10')).toBe(30 * 60);
    expect(perDay.get('2026-09-11')).toBe(90 * 60);
  });

  it('clips a session that started before the window', () => {
    const perDay = secondsPerDay([{ start: S('2026-08-31T20:00:00Z'), end: S('2026-09-01T01:00:00Z') }], win.start, win.end, 60);
    expect([...perDay.keys()]).toEqual(['2026-09-01']);
    expect(perDay.get('2026-09-01')).toBe(2 * 3600); // 23:00 UTC (00:00 local) to 01:00 UTC
  });

  it('ignores a session entirely outside the window', () => {
    expect(secondsPerDay([{ start: S('2026-07-01T00:00:00Z'), end: S('2026-07-01T05:00:00Z') }], win.start, win.end, 60).size).toBe(0);
  });
});

describe('dayPeriod', () => {
  it('is the same function missions relies on', () => {
    expect(dayPeriod(S('2026-09-19T23:30:00Z'), 60).key).toBe('2026-09-20');
  });
});
