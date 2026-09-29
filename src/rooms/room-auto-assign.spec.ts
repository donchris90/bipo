import { RoomsService } from './rooms.service';

function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    partyRoom: { findUnique: jest.fn(), update: jest.fn() },
    roomSeat: { findUnique: jest.fn(), delete: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
    roomSeatLock: { findUnique: jest.fn() },
    seatRequest: { findFirst: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    // A transaction here just runs the callback against this same mock — enough to test the
    // logic and ordering, not real isolation.
    $transaction: jest.fn((fn: any) => fn(prisma)),
    ...overrides.prisma,
  };
  const notifications: any = { notifyOnce: jest.fn().mockResolvedValue(undefined), ...overrides.notifications };
  const realtime: any = { broadcastRoomState: jest.fn(), ...overrides.realtime };
  const moderation: any = { isBanned: jest.fn().mockResolvedValue(false), ...overrides.moderation };
  const roomCommunity: any = { recordVisit: jest.fn(), ...overrides.roomCommunity };
  return {
    service: new RoomsService(prisma, {} as any, moderation, {} as any, realtime, notifications, {} as any, roomCommunity),
    prisma,
    notifications,
    realtime,
  };
}

describe('RoomsService.releaseSeat — auto-fill from the queue', () => {
  const seat = { id: 'seat-1', roomId: 'room-1', userId: 'leaver-1', seatNumber: 3 };

  it('does nothing extra if the user held no seat', async () => {
    const { service, prisma } = makeService();
    prisma.roomSeat.findUnique.mockResolvedValue(null);
    await expect(service.releaseSeat('room-1', 'nobody')).resolves.toEqual({ left: true });
    expect(prisma.roomSeat.delete).not.toHaveBeenCalled();
    expect(prisma.partyRoom.findUnique).not.toHaveBeenCalled();
  });

  it('just frees the seat when auto-assign is off, even with someone waiting', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.roomSeat.findUnique.mockResolvedValue(seat);
    prisma.partyRoom.findUnique.mockResolvedValue({ autoAssignSeats: false, title: 'Chill Room' });

    await expect(service.releaseSeat('room-1', 'leaver-1')).resolves.toEqual({ left: true });
    expect(prisma.roomSeat.delete).toHaveBeenCalledWith({ where: { roomId_userId: { roomId: 'room-1', userId: 'leaver-1' } } });
    expect(prisma.seatRequest.findFirst).not.toHaveBeenCalled();
    expect(notifications.notifyOnce).not.toHaveBeenCalled();
  });

  it('seats the longest-waiting request into the freed seat when auto-assign is on', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.roomSeat.findUnique.mockResolvedValue(seat);
    prisma.partyRoom.findUnique.mockResolvedValue({ autoAssignSeats: true, title: 'Chill Room' });
    prisma.roomSeatLock.findUnique.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue({ id: 'req-1', userId: 'waiter-1', status: 'PENDING' });
    prisma.roomSeat.findFirst.mockResolvedValue(null); // waiter-1 doesn't already hold a seat

    await service.releaseSeat('room-1', 'leaver-1');

    expect(prisma.roomSeat.create).toHaveBeenCalledWith({ data: { roomId: 'room-1', userId: 'waiter-1', seatNumber: 3 } });
    expect(prisma.seatRequest.update).toHaveBeenCalledWith({ where: { id: 'req-1' }, data: { status: 'APPROVED', decidedAt: expect.any(Date) } });
    expect(notifications.notifyOnce).toHaveBeenCalledWith('waiter-1', 'SEAT_APPROVED', 'seat:req-1', { roomId: 'room-1', roomTitle: 'Chill Room', seatNumber: 3 });
  });

  it('never fills a seat the host just locked, even with someone waiting', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.roomSeat.findUnique.mockResolvedValue(seat);
    prisma.partyRoom.findUnique.mockResolvedValue({ autoAssignSeats: true, title: 'Chill Room' });
    prisma.roomSeatLock.findUnique.mockResolvedValue({ id: 'lock-1' });
    prisma.seatRequest.findFirst.mockResolvedValue({ id: 'req-1', userId: 'waiter-1' });

    await service.releaseSeat('room-1', 'leaver-1');

    expect(prisma.roomSeat.create).not.toHaveBeenCalled();
    expect(notifications.notifyOnce).not.toHaveBeenCalled();
  });

  it('leaves the seat empty when auto-assign is on but nobody is waiting', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.roomSeat.findUnique.mockResolvedValue(seat);
    prisma.partyRoom.findUnique.mockResolvedValue({ autoAssignSeats: true, title: 'Chill Room' });
    prisma.roomSeatLock.findUnique.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue(null);

    await service.releaseSeat('room-1', 'leaver-1');

    expect(prisma.roomSeat.create).not.toHaveBeenCalled();
    expect(notifications.notifyOnce).not.toHaveBeenCalled();
  });

  it('never double-seats someone whose request is stale because they already hold a seat', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.roomSeat.findUnique.mockResolvedValue(seat);
    prisma.partyRoom.findUnique.mockResolvedValue({ autoAssignSeats: true, title: 'Chill Room' });
    prisma.roomSeatLock.findUnique.mockResolvedValue(null);
    prisma.seatRequest.findFirst.mockResolvedValue({ id: 'req-1', userId: 'waiter-1' });
    prisma.roomSeat.findFirst.mockResolvedValue({ id: 'existing-seat', seatNumber: 5 }); // already seated elsewhere

    await service.releaseSeat('room-1', 'leaver-1');

    expect(prisma.roomSeat.create).not.toHaveBeenCalled();
    // The stale request is still resolved so it stops showing up in the queue.
    expect(prisma.seatRequest.update).toHaveBeenCalledWith({ where: { id: 'req-1' }, data: { status: 'APPROVED', decidedAt: expect.any(Date) } });
    expect(notifications.notifyOnce).not.toHaveBeenCalled();
  });
});

describe('RoomsService.setAutoAssign', () => {
  it('requires the actor to be the host or a moderator', async () => {
    const { service, moderation, prisma } = makeService() as any;
    prisma.partyRoom.findUnique.mockResolvedValue(null); // assertHostOrModerator's own lookup fails
    await expect(service.setAutoAssign('room-1', 'stranger', true)).rejects.toThrow();
  });

  it('updates and returns the new value', async () => {
    const { service, prisma } = makeService();
    prisma.partyRoom.findUnique.mockResolvedValue({ id: 'room-1', hostId: 'host-1' });
    prisma.partyRoom.update.mockResolvedValue({ autoAssignSeats: false });

    const result = await service.setAutoAssign('room-1', 'host-1', false);

    expect(prisma.partyRoom.update).toHaveBeenCalledWith({ where: { id: 'room-1' }, data: { autoAssignSeats: false }, select: { autoAssignSeats: true } });
    expect(result).toEqual({ autoAssignSeats: false });
  });
});
