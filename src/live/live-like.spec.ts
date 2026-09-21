import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LiveService } from './live.service';

function build(hostId = 'host') {
  const prisma: any = {
    liveSession: {
      findUnique: jest.fn(async ({ select }: any) => (select?.hostId ? { hostId } : { likeCount: 5 })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const realtime: any = { broadcastLiveLike: jest.fn() };
  return { svc: new LiveService(prisma, {} as any, {} as any, realtime), prisma, realtime };
}

describe('likes on a live stream', () => {
  it("the host can't like their own stream, and nothing is counted or broadcast", async () => {
    const { svc, prisma, realtime } = build('host');
    await expect(svc.like('s1', 'host', 3)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.like('s1', 'host', 3)).rejects.toThrow("You can't like your own live");
    expect(prisma.liveSession.updateMany).not.toHaveBeenCalled();
    expect(realtime.broadcastLiveLike).not.toHaveBeenCalled();
  });

  it('a viewer still can', async () => {
    const { svc, prisma, realtime } = build('host');
    expect(await svc.like('s1', 'viewer', 2)).toEqual({ likeCount: 5 });
    expect(prisma.liveSession.updateMany).toHaveBeenCalled();
    expect(realtime.broadcastLiveLike).toHaveBeenCalledWith('s1', expect.objectContaining({ userId: 'viewer', count: 2 }));
  });

  it('a session that has ended still answers "not found" for a viewer', async () => {
    const { svc, prisma } = build('host');
    prisma.liveSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.like('s1', 'viewer')).rejects.toBeInstanceOf(NotFoundException);
  });
});
