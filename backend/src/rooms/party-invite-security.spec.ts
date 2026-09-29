import { ForbiddenException } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { RoomPrivacy } from '@prisma/client';

function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    partyRoom: { findUnique: jest.fn() },
    roomSeat: { findFirst: jest.fn() },
    seatRequest: { findFirst: jest.fn() },
    ...overrides.prisma,
  };
  const moderation: any = { isBanned: jest.fn().mockResolvedValue(false), ...overrides.moderation };
  const rtc: any = { generateToken: jest.fn().mockResolvedValue('rtc-token'), ...overrides.rtc };
  const roomCommunity: any = { recordVisit: jest.fn(), ...overrides.roomCommunity };
  return {
    service: new RoomsService(
      prisma,
      {} as any,
      moderation,
      rtc,
      {} as any,
      {} as any,
      {} as any,
      roomCommunity,
    ),
    prisma,
    moderation,
    rtc,
    roomCommunity,
  };
}

describe('Party INVITE_ONLY access enforcement', () => {
  const room = { id: 'room-1', hostId: 'host-1', privacy: RoomPrivacy.INVITE_ONLY, status: 'OPEN', providerChannel: 'room-channel' };

  it('rejects an uninvited user before issuing an RTC token', async () => {
    const { service, prisma, rtc } = makeService();
    prisma.partyRoom.findUnique.mockResolvedValue(room);
    prisma.roomSeat.findFirst.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue(null);

    await expect(service.joinToken(room.id, 'guest-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(rtc.generateToken).not.toHaveBeenCalled();
  });

  it('allows a guest with an accepted invitation to receive an RTC token', async () => {
    const { service, prisma, rtc } = makeService();
    prisma.partyRoom.findUnique.mockResolvedValue(room);
    prisma.roomSeat.findFirst.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue({ id: 'invite-1' });

    await expect(service.joinToken(room.id, 'guest-1')).resolves.toMatchObject({ token: 'rtc-token' });
    expect(rtc.generateToken).toHaveBeenCalledWith(room.providerChannel, 'guest-1', 'audience');
  });

  it('does not let a pending invite bypass the accept step through join-request', async () => {
    const { service, prisma } = makeService();
    prisma.partyRoom.findUnique.mockResolvedValue(room);
    prisma.roomSeat.findFirst.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue(null);

    await expect(service.joinRequest(room.id, 'guest-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let a pending invite bypass the accept step through direct seat selection', async () => {
    const { service, prisma } = makeService();
    prisma.partyRoom.findUnique.mockResolvedValue({ ...room, seatCount: 4, locked: false });
    prisma.roomSeat.findFirst.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue(null);

    await expect(service.requestSeat(room.id, 'guest-1', 1)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
