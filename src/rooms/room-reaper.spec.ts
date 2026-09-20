import { RoomReaperService } from './room-reaper.service';
import { RoomsService } from './rooms.service';

const GRACE = 90_000;

describe('RoomReaperService', () => {
  const build = (present: string[]) => {
    const prisma: any = { partyRoom: { findMany: jest.fn().mockResolvedValue([{ id: 'r1', hostId: 'h1' }, { id: 'r2', hostId: 'h2' }]) } };
    const realtime: any = { isUserInRoom: jest.fn(async (_u: string, room: string) => present.includes(room)) };
    const rooms: any = { closeAbandoned: jest.fn().mockResolvedValue({}) };
    return { svc: new RoomReaperService(prisma, realtime, rooms), rooms, realtime };
  };

  it('closes only the room whose host is missing, and only after the grace period', async () => {
    const { svc, rooms } = build(['ROOM:r1']);
    expect(await svc.sweep(0, GRACE)).toEqual([]);
    expect(await svc.sweep(GRACE - 1, GRACE)).toEqual([]);
    expect(await svc.sweep(GRACE, GRACE)).toEqual(['r2']);
    expect(rooms.closeAbandoned).toHaveBeenCalledWith('r2');
    expect(rooms.closeAbandoned).not.toHaveBeenCalledWith('r1');
  });

  it("looks for the host in the room's socket room (ROOM:<id>)", async () => {
    const { svc, realtime } = build(['ROOM:r1', 'ROOM:r2']);
    await svc.sweep(0, GRACE);
    expect(realtime.isUserInRoom).toHaveBeenCalledWith('h1', 'ROOM:r1');
  });
});

describe('RoomsService closing', () => {
  const room = (status: string) => ({ id: 'r', hostId: 'h', providerChannel: 'c', status });
  const build = (status: string) => {
    const prisma: any = { partyRoom: { findUnique: jest.fn().mockResolvedValue(room(status)), findUniqueOrThrow: jest.fn().mockResolvedValue(room('CLOSED')), update: jest.fn(async ({ data }: any) => data) } };
    const rtc: any = { destroyChannel: jest.fn() };
    const svc = new RoomsService(prisma, {} as any, {} as any, rtc, {} as any, {} as any);
    return { svc, prisma, rtc };
  };

  it('closing a room that is already closed changes nothing', async () => {
    const { svc, prisma, rtc } = build('CLOSED');
    await svc.close('r', 'h');
    expect(prisma.partyRoom.update).not.toHaveBeenCalled();
    expect(rtc.destroyChannel).not.toHaveBeenCalled();
  });

  it('only the host can close, but the sweeper can close an abandoned room', async () => {
    const { svc, prisma } = build('OPEN');
    await expect(svc.close('r', 'someone-else')).rejects.toThrow('Only the host');
    await svc.closeAbandoned('r');
    expect(prisma.partyRoom.update.mock.calls[0][0].data.status).toBe('CLOSED');
  });
});
