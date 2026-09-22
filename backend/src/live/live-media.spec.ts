import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LiveMediaService } from './live-media.service';

const T0 = 1_000_000;

function build(over: { hostId?: string; status?: string; video?: any } = {}) {
  const prisma: any = {
    liveSession: { findUnique: jest.fn().mockResolvedValue(over.status === 'none' ? null : { hostId: over.hostId ?? 'host', status: over.status ?? 'LIVE' }) },
    video: { findUnique: jest.fn().mockResolvedValue(over.video === undefined ? { id: 'v1', creatorId: 'host', title: 'My clip', videoUrl: 'https://cdn/v1.mp4', status: 'PUBLISHED' } : over.video) },
  };
  const realtime: any = { broadcastLiveMedia: jest.fn() };
  return { svc: new LiveMediaService(prisma, realtime), realtime, prisma };
}

describe('LiveMediaService — sharing a video in a live', () => {
  it('loads one of the host\'s own published videos, starts it playing, and tells everyone in the live', async () => {
    const { svc, realtime } = build();
    const out: any = await svc.act('s1', 'host', { action: 'load', videoId: 'v1' }, T0);
    expect(out).toMatchObject({ active: true, videoId: 'v1', title: 'My clip', url: 'https://cdn/v1.mp4', status: 'PLAYING', positionMs: 0, serverNow: T0 });
    expect(realtime.broadcastLiveMedia).toHaveBeenCalledWith('s1', expect.objectContaining({ videoId: 'v1', status: 'PLAYING' }));
  });

  it('only the host can control it, and only while the live is on', async () => {
    await expect(build().svc.act('s1', 'someone-else', { action: 'load', videoId: 'v1' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(build({ status: 'ENDED' }).svc.act('s1', 'host', { action: 'load', videoId: 'v1' })).rejects.toThrow(/ended/);
    await expect(build({ status: 'none' }).svc.act('s1', 'host', { action: 'load', videoId: 'v1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses someone else's video, an unpublished one, or no video at all", async () => {
    await expect(build({ video: { id: 'v1', creatorId: 'other', title: 't', videoUrl: 'u', status: 'PUBLISHED' } }).svc.act('s1', 'host', { action: 'load', videoId: 'v1' })).rejects.toThrow(/your published videos/);
    await expect(build({ video: { id: 'v1', creatorId: 'host', title: 't', videoUrl: 'u', status: 'REMOVED' } }).svc.act('s1', 'host', { action: 'load', videoId: 'v1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ video: null }).svc.act('s1', 'host', { action: 'load', videoId: 'v1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build().svc.act('s1', 'host', { action: 'load' })).rejects.toThrow(/videoId/);
  });

  it('pausing freezes the position; playing again continues from there; a late joiner sees where it is now', async () => {
    const { svc } = build();
    await svc.act('s1', 'host', { action: 'load', videoId: 'v1' }, T0);
    // 5 seconds later the host pauses (their player says 5.2 s)
    const paused: any = await svc.act('s1', 'host', { action: 'pause', positionMs: 5200 }, T0 + 5000);
    expect(paused).toMatchObject({ status: 'PAUSED', positionMs: 5200, updatedAt: T0 + 5000 });
    // paused for a minute: a viewer joining now still gets 5.2 s
    expect(svc.get('s1', T0 + 65_000)).toMatchObject({ status: 'PAUSED', positionMs: 5200 });
    await svc.act('s1', 'host', { action: 'play' }, T0 + 65_000);
    // 3 seconds after play, a viewer asks: the server has extrapolated from play time
    const later: any = svc.get('s1', T0 + 68_000);
    const expected = later.positionMs + (later.serverNow - later.updatedAt);
    expect(expected).toBe(5200 + 3000);
  });

  it('seek moves the position without changing whether it is playing; sync corrects drift only while playing', async () => {
    const { svc } = build();
    await svc.act('s1', 'host', { action: 'load', videoId: 'v1' }, T0);
    const sought: any = await svc.act('s1', 'host', { action: 'seek', positionMs: 60_000 }, T0 + 1000);
    expect(sought).toMatchObject({ status: 'PLAYING', positionMs: 60_000 });
    const synced: any = await svc.act('s1', 'host', { action: 'sync', positionMs: 61_500 }, T0 + 2000);
    expect(synced.positionMs).toBe(61_500);
    await svc.act('s1', 'host', { action: 'pause', positionMs: 62_000 }, T0 + 3000);
    const noop: any = await svc.act('s1', 'host', { action: 'sync', positionMs: 99_000 }, T0 + 4000);
    expect(noop.positionMs).toBe(62_000); // a stale heartbeat cannot move a paused video
  });

  it('stop removes it and tells everyone; nothing to control afterwards', async () => {
    const { svc, realtime } = build();
    await svc.act('s1', 'host', { action: 'load', videoId: 'v1' }, T0);
    expect(await svc.act('s1', 'host', { action: 'stop' }, T0 + 10)).toMatchObject({ active: false });
    expect(realtime.broadcastLiveMedia).toHaveBeenLastCalledWith('s1', expect.objectContaining({ active: false }));
    expect(svc.get('s1')).toMatchObject({ active: false });
    await expect(svc.act('s1', 'host', { action: 'play' })).rejects.toThrow(/No video is being shared/);
  });

  it('validates the action and the position', async () => {
    const { svc } = build();
    await svc.act('s1', 'host', { action: 'load', videoId: 'v1' }, T0);
    await expect(svc.act('s1', 'host', { action: 'explode' })).rejects.toThrow(/action must be one of/);
    await expect(svc.act('s1', 'host', { action: 'seek', positionMs: -5 })).rejects.toThrow(/positionMs/);
    await expect(svc.act('s1', 'host', { action: 'seek', positionMs: 'abc' })).rejects.toThrow(/positionMs/);
  });

  it('when the live ends the shared video ends with it', async () => {
    const { svc, realtime } = build();
    await svc.act('s1', 'host', { action: 'load', videoId: 'v1' }, T0);
    svc.clear('s1', T0 + 1);
    expect(realtime.broadcastLiveMedia).toHaveBeenLastCalledWith('s1', expect.objectContaining({ active: false }));
    expect(svc.get('s1')).toMatchObject({ active: false });
    realtime.broadcastLiveMedia.mockClear();
    svc.clear('s1'); // nothing left: no second broadcast
    expect(realtime.broadcastLiveMedia).not.toHaveBeenCalled();
  });
});
