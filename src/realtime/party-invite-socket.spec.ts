import { RealtimeGateway } from './realtime.gateway';

function makeGateway() {
  const prisma: any = {
    partyRoom: { findUnique: jest.fn() },
    roomSeat: { findFirst: jest.fn() },
    seatRequest: { findFirst: jest.fn() },
  };
  const moderation: any = {
    isBanned: jest.fn().mockResolvedValue(false),
    isMuted: jest.fn().mockResolvedValue(false),
  };
  const gateway = new RealtimeGateway({} as any, {} as any, prisma, moderation);
  return { gateway, prisma, moderation };
}

describe('Party invite-only socket enforcement', () => {
  it('rejects an uninvited user from joining the room socket', async () => {
    const { gateway, prisma } = makeGateway();
    prisma.partyRoom.findUnique.mockResolvedValue({ hostId: 'host', privacy: 'INVITE_ONLY' });
    prisma.roomSeat.findFirst.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue(null);
    const client: any = { data: { userId: 'guest' }, join: jest.fn(), to: jest.fn(() => ({ emit: jest.fn() })) };

    await expect(gateway.handleJoin({ context: 'ROOM', contextId: 'room-1' }, client)).resolves.toEqual({ error: 'invite_only' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('allows an accepted invite to join the room socket', async () => {
    const { gateway, prisma } = makeGateway();
    prisma.partyRoom.findUnique.mockResolvedValue({ hostId: 'host', privacy: 'INVITE_ONLY' });
    prisma.roomSeat.findFirst.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue({ id: 'invite-1' });
    const client: any = { data: { userId: 'guest' }, join: jest.fn(), to: jest.fn(() => ({ emit: jest.fn() })) };

    await expect(gateway.handleJoin({ context: 'ROOM', contextId: 'room-1' }, client)).resolves.toEqual({ joined: true });
    expect(client.join).toHaveBeenCalledWith('ROOM:room-1');
  });
});
