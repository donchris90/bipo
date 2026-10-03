import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LiveService } from './live.service';

const HOST = 'host-1';
const MOD = 'mod-1';
const VIEWER = 'viewer-1';
const OUTSIDER = 'outsider-1';
const SESSION = 'session-1';

function build(opts: { status?: string; moderators?: string[] } = {}) {
  const moderators = new Set(opts.moderators ?? []);
  const prisma: any = {
    liveSession: {
      findUnique: jest.fn(async () => ({ id: SESSION, hostId: HOST, status: opts.status ?? 'LIVE' })),
    },
    liveModerator: {
      findUnique: jest.fn(async ({ where }: any) =>
        moderators.has(where.sessionId_userId.userId) ? { id: 'm', ...where.sessionId_userId } : null,
      ),
      findMany: jest.fn(async () => [...moderators].map((userId) => ({ userId }))),
      upsert: jest.fn(async ({ create }: any) => {
        moderators.add(create.userId);
        return create;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        moderators.delete(where.userId);
        return { count: 1 };
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === 'ghost' ? null : { id: where.id })),
    },
    liveViewer: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => [
        { userId: VIEWER, joinedAt: new Date(1), user: { id: VIEWER, displayName: 'V' } },
        { userId: MOD, joinedAt: new Date(2), user: { id: MOD, displayName: 'M' } },
      ]),
    },
    moderationAction: { create: jest.fn(async () => ({})) },
  };
  const realtime: any = { broadcastLiveModeration: jest.fn() };
  const service = new LiveService(prisma, {} as any, {} as any, realtime, {} as any, {} as any, {} as any, {} as any);
  jest.spyOn(service as any, 'publishViewerCount').mockResolvedValue(undefined);
  return { service, prisma, realtime, moderators };
}

describe('live moderators', () => {
  describe('who may moderate viewers', () => {
    it('lets the host kick a viewer', async () => {
      const { service } = build();
      await expect(service.kickViewer(SESSION, HOST, VIEWER)).resolves.toEqual({ removed: true });
    });

    it('lets an appointed moderator kick, mute and ban a viewer', async () => {
      const { service } = build({ moderators: [MOD] });
      await expect(service.kickViewer(SESSION, MOD, VIEWER)).resolves.toEqual({ removed: true });
      await expect(service.muteViewer(SESSION, MOD, VIEWER)).resolves.toEqual({ muted: true });
      await expect(service.banViewer(SESSION, MOD, VIEWER)).resolves.toEqual({ banned: true });
    });

    it('lets an appointed moderator undo a mute or ban', async () => {
      const { service } = build({ moderators: [MOD] });
      await expect(service.unmuteViewer(SESSION, MOD, VIEWER)).resolves.toEqual({ muted: false });
      await expect(service.unbanViewer(SESSION, MOD, VIEWER)).resolves.toEqual({ banned: false });
    });

    it('rejects someone who is neither host nor moderator', async () => {
      const { service, prisma } = build({ moderators: [MOD] });
      await expect(service.kickViewer(SESSION, OUTSIDER, VIEWER)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.banViewer(SESSION, OUTSIDER, VIEWER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.liveViewer.updateMany).not.toHaveBeenCalled();
      expect(prisma.moderationAction.create).not.toHaveBeenCalled();
    });

    it('never lets a moderator act against the host', async () => {
      const { service } = build({ moderators: [MOD] });
      await expect(service.kickViewer(SESSION, MOD, HOST)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.muteViewer(SESSION, MOD, HOST)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.banViewer(SESSION, MOD, HOST)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses moderation once the session is no longer live, even from the host', async () => {
      const { service } = build({ status: 'ENDED', moderators: [MOD] });
      await expect(service.kickViewer(SESSION, HOST, VIEWER)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.kickViewer(SESSION, MOD, VIEWER)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('appointing moderators', () => {
    it('lets the host appoint a moderator and records it in the audit trail', async () => {
      const { service, prisma, moderators } = build();
      await expect(service.addModerator(SESSION, HOST, VIEWER)).resolves.toEqual({ added: true });
      expect(moderators.has(VIEWER)).toBe(true);
      expect(prisma.moderationAction.create).toHaveBeenCalledWith({
        data: { actorId: HOST, actionType: 'ADD_MODERATOR', context: 'LIVE', contextId: SESSION, targetUserId: VIEWER },
      });
    });

    it('is safe to appoint the same person twice', async () => {
      const { service, moderators } = build();
      await service.addModerator(SESSION, HOST, VIEWER);
      await service.addModerator(SESSION, HOST, VIEWER);
      expect(moderators.size).toBe(1);
    });

    it('does not let the host appoint themselves, or a user that does not exist', async () => {
      const { service } = build();
      await expect(service.addModerator(SESSION, HOST, HOST)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.addModerator(SESSION, HOST, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not let a moderator appoint or dismiss other moderators', async () => {
      const { service, moderators } = build({ moderators: [MOD] });
      await expect(service.addModerator(SESSION, MOD, VIEWER)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.removeModerator(SESSION, MOD, MOD)).rejects.toBeInstanceOf(ForbiddenException);
      expect([...moderators]).toEqual([MOD]);
    });

    it('lets the host dismiss a moderator, who then loses the powers', async () => {
      const { service } = build({ moderators: [MOD] });
      await expect(service.removeModerator(SESSION, HOST, MOD)).resolves.toEqual({ removed: true });
      await expect(service.kickViewer(SESSION, MOD, VIEWER)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does not let an outsider appoint anyone', async () => {
      const { service } = build();
      await expect(service.addModerator(SESSION, OUTSIDER, VIEWER)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('viewer list', () => {
    it('flags which viewers are moderators, which is what the app reads', async () => {
      const { service } = build({ moderators: [MOD] });
      const list = await service.listViewers(SESSION, HOST);
      expect(list.map((v: any) => [v.userId, v.isModerator])).toEqual([
        [VIEWER, false],
        [MOD, true],
      ]);
    });

    it('is available to a moderator but not to an outsider', async () => {
      const { service } = build({ moderators: [MOD] });
      await expect(service.listViewers(SESSION, MOD)).resolves.toHaveLength(2);
      await expect(service.listViewers(SESSION, OUTSIDER)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
