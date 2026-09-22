import { LiveReaperService } from './live-reaper.service';
import { decideAbandoned } from './live-reaper';
import { LiveService } from './live.service';

const GRACE = 90_000;

describe('decideAbandoned', () => {
  const run = (over: Partial<Parameters<typeof decideAbandoned>[0]> & { absentSince?: Map<string, number> }) => {
    const absentSince = over.absentSince ?? new Map<string, number>();
    const out = decideAbandoned({ sessionIds: ['a'], present: new Set(), absentSince, now: 1_000_000, graceMs: GRACE, ...over });
    return { out, absentSince };
  };

  it('starts the clock the first time a host is missing, without ending anything', () => {
    const { out, absentSince } = run({});
    expect(out).toEqual([]);
    expect(absentSince.get('a')).toBe(1_000_000);
  });

  it('does not end a session before the grace period is over', () => {
    const { out } = run({ absentSince: new Map([['a', 1_000_000 - (GRACE - 1)]]) });
    expect(out).toEqual([]);
  });

  it('ends a session whose host has been away for the whole grace period', () => {
    const { out } = run({ absentSince: new Map([['a', 1_000_000 - GRACE]]) });
    expect(out).toEqual(['a']);
  });

  it('resets the clock as soon as the host is back', () => {
    const { out, absentSince } = run({ present: new Set(['a']), absentSince: new Map([['a', 1]]) });
    expect(out).toEqual([]);
    expect(absentSince.has('a')).toBe(false);
  });

  it('forgets sessions that are no longer live', () => {
    const { absentSince } = run({ sessionIds: [], absentSince: new Map([['gone', 5]]) });
    expect(absentSince.size).toBe(0);
  });
});

describe('LiveReaperService.sweep', () => {
  const build = (present: string[]) => {
    const prisma: any = { liveSession: { findMany: jest.fn().mockResolvedValue([{ id: 's1', hostId: 'h1' }, { id: 's2', hostId: 'h2' }]) } };
    const realtime: any = { isUserInRoom: jest.fn(async (_u: string, room: string) => present.includes(room)) };
    const live: any = { endAbandoned: jest.fn().mockResolvedValue({}) };
    return { svc: new LiveReaperService(prisma, realtime, live as LiveService), live, realtime };
  };

  it('ends only the session whose host is missing, and only after the grace period', async () => {
    const { svc, live } = build(['LIVE:s1']); // host of s2 is not in its room
    expect(await svc.sweep(0, GRACE)).toEqual([]); // first sighting: clock starts
    expect(await svc.sweep(GRACE - 1, GRACE)).toEqual([]);
    expect(await svc.sweep(GRACE, GRACE)).toEqual(['s2']);
    expect(live.endAbandoned).toHaveBeenCalledWith('s2');
    expect(live.endAbandoned).not.toHaveBeenCalledWith('s1');
  });

  it('checks presence in the right room for the right host', async () => {
    const { svc, realtime } = build(['LIVE:s1', 'LIVE:s2']);
    await svc.sweep(0, GRACE);
    expect(realtime.isUserInRoom).toHaveBeenCalledWith('h1', 'LIVE:s1');
    expect(realtime.isUserInRoom).toHaveBeenCalledWith('h2', 'LIVE:s2');
  });

  it('a failure while ending one session does not stop the sweep or throw', async () => {
    const { svc, live } = build([]);
    live.endAbandoned.mockRejectedValueOnce(new Error('rtc down')).mockResolvedValue({});
    await svc.sweep(0, GRACE);
    await expect(svc.sweep(GRACE, GRACE)).resolves.toEqual(['s2']);
  });
});

describe('LiveService cover + end', () => {
  it('only accepts an https image URL as a cover', () => {
    expect(LiveService.cleanCoverUrl('https://i.ibb.co/x/y.jpg')).toBe('https://i.ibb.co/x/y.jpg');
    expect(LiveService.cleanCoverUrl('http://insecure.example/x.jpg')).toBeNull();
    expect(LiveService.cleanCoverUrl('javascript:alert(1)')).toBeNull();
    expect(LiveService.cleanCoverUrl('not a url')).toBeNull();
    expect(LiveService.cleanCoverUrl('https://x.com/' + 'a'.repeat(600))).toBeNull();
    expect(LiveService.cleanCoverUrl(undefined)).toBeNull();
  });

  it('ending an already-ended session leaves its real end time alone', async () => {
    const ended = { id: 's', hostId: 'h', providerChannel: 'c', status: 'ENDED', startedAt: new Date(0), endedAt: new Date(5000), durationSeconds: 5 };
    const prisma: any = {
      liveSession: { findUnique: jest.fn().mockResolvedValue(ended), findUniqueOrThrow: jest.fn().mockResolvedValue(ended), update: jest.fn() },
      liveViewer: { updateMany: jest.fn() },
    };
    const rtc: any = { destroyChannel: jest.fn() };
    const svc = new LiveService(prisma, rtc, {} as any, {} as any);
    await svc.end('s', 'h');
    expect(prisma.liveSession.update).not.toHaveBeenCalled();
    expect(rtc.destroyChannel).not.toHaveBeenCalled();
  });
});
