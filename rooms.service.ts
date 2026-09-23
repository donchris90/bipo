import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ModerationService } from '../moderation/moderation.service';
import { RoomPrivacy } from '@prisma/client';
import { RTC_PROVIDER } from '../live/live.service';
import type { RtcProvider } from '../live/providers/rtc-provider.interface';
import { fetchChatHistory } from '../common/chat-history';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotBlocked } from '../common/blocks';

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly moderation: ModerationService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  async create(hostId: string, title: string, privacy: RoomPrivacy, seatCount: number, countryCode: string, category?: string, themeColor?: string, mode?: string) {
    // Real channel, same RtcProvider abstraction LiveSession already
    // uses — this is the piece that was missing entirely before: a room
    // could be created, seats assigned, moderation applied, but nothing
    // ever gave anyone in it an actual voice channel to speak on.
    const { channelName } = await this.rtc.createChannel(`room-${Date.now()}`);
    const room = await this.prisma.partyRoom.create({
      data: {
        hostId,
        title,
        privacy,
        seatCount: Math.min(Math.max(seatCount, 4), 12),
        countryCode,
        providerChannel: channelName,
        category,
        themeColor: themeColor && /^#[0-9A-Fa-f]{6}$/.test(themeColor) ? themeColor : null,
        mode: mode === 'VIDEO' ? 'VIDEO' : 'AUDIO',
      },
    });
    // Host occupies seat 0 by convention. Every guest seat starts locked:
    // pressing Join creates a queue request; the host explicitly brings a
    // waiting guest up, which unlocks the selected seat for that guest.
    await this.prisma.$transaction([
      this.prisma.roomSeat.create({ data: { roomId: room.id, userId: hostId, seatNumber: 0 } }),
      this.prisma.roomSeatLock.createMany({
        data: Array.from({ length: Math.max(0, room.seatCount - 1) }, (_, index) => ({
          roomId: room.id,
          seatNumber: index + 1,
        })),
        skipDuplicates: true,
      }),
    ]);
    return room;
  }

  // Real room details + who's actually in which seat right now — the
  // other half of what was missing (a room could be created and joined,
  // but nothing ever returned "here's the current seat layout" for a
  // client to actually render). Real display names via a batch lookup,
  // same pattern used elsewhere in this backend (GiftService.ranking,
  // LiveService.findMyWatchHistory) since RoomSeat has no direct User
  // relation to include.
  // Nothing ever let an invited user discover an invite existed at all —
  // inviteToSeat() created a real SeatRequest with invitedByHost=true,
  // but there was no way to list "invites sent to me" across every room.
  // Joined with room title + host displayName since an invite with just
  // a bare roomId would be meaningless to show someone.
  async findMyInvites(userId: string) {
    const invites = await this.prisma.seatRequest.findMany({
      where: { userId, status: 'PENDING', invitedByHost: true },
      orderBy: { createdAt: 'desc' },
    });
    if (invites.length === 0) return [];

    const rooms = await this.prisma.partyRoom.findMany({
      where: { id: { in: invites.map((i) => i.roomId) } },
      select: { id: true, title: true, hostId: true, status: true },
    });
    const roomById = new Map(rooms.map((r) => [r.id, r]));

    const hosts = await this.prisma.user.findMany({
      where: { id: { in: rooms.map((r) => r.hostId) } },
      select: { id: true, displayName: true },
    });
    const hostById = new Map(hosts.map((h) => [h.id, h]));

    return invites
      .map((invite) => {
        const room = roomById.get(invite.roomId);
        if (!room || room.status !== 'OPEN') return null; // room closed since inviting
        return {
          requestId: invite.id,
          roomId: room.id,
          roomTitle: room.title,
          hostDisplayName: hostById.get(room.hostId)?.displayName ?? null,
          createdAt: invite.createdAt,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  async getRoomDetails(roomId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');

    const seats = await this.prisma.roomSeat.findMany({ where: { roomId }, orderBy: { seatNumber: 'asc' } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: seats.map((s) => s.userId) } },
      select: { id: true, displayName: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    // assertHostOrModerator already lets a designated moderator do
    // everything a host can (approve requests, kick, ban) — but nothing
    // ever told the client who the moderators actually are, so mobile
    // could only ever show those controls to the literal host, hiding
    // real capabilities a moderator genuinely has.
    const [moderators, mutedUserIds, locks] = await Promise.all([
      this.prisma.roomModerator.findMany({ where: { roomId }, select: { userId: true } }),
      this.moderation.mutedUserIds('ROOM', roomId),
      this.prisma.roomSeatLock.findMany({ where: { roomId }, select: { seatNumber: true } }),
    ]);
    const lockedNumbers = new Set(locks.map((l) => l.seatNumber));

    return {
      ...room,
      moderatorIds: moderators.map((m) => m.userId),
      mutedUserIds,
      lockedSeatNumbers: [...lockedNumbers],
      seats: seats.map((s) => ({
        seatNumber: s.seatNumber,
        userId: s.userId,
        displayName: userById.get(s.userId)?.displayName ?? null,
        joinedAt: s.joinedAt,
        locked: lockedNumbers.has(s.seatNumber),
      })),
    };
  }

  // A real, fresh publish/subscribe token for this specific user — host
  // role (publish audio/video) if they currently hold a seat, audience
  // role (listen only) otherwise. Called every time someone actually
  // enters the room screen, same as LiveService.joinToken's pattern —
  // not cached, since seat status can change between visits.
  async joinToken(roomId: string, userId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.status !== 'OPEN') throw new NotFoundException('Room is closed');
    if (await this.moderation.isBanned('ROOM', roomId, userId)) {
      throw new ForbiddenException('You are banned from this room');
    }

    const seat = await this.prisma.roomSeat.findFirst({ where: { roomId, userId } });
    // A muted guest keeps their seat but is issued a subscribe-only token,
    // so the mute holds at the RTC layer even if the client ignores the
    // 'room:moderation' event or reconnects.
    const muted = await this.moderation.isMuted('ROOM', roomId, userId);
    const role = seat && !muted ? 'host' : 'audience';
    const token = await this.rtc.generateToken(room.providerChannel, userId, role);
    return { room, token, role, muted };
  }

  async joinRequest(roomId: string, userId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room || room.status !== 'OPEN') throw new NotFoundException('Room not open');
    if (room.locked) throw new BadRequestException('Room is locked');
    if (await this.moderation.isBanned('ROOM', roomId, userId)) {
      throw new ForbiddenException('You are banned from this room');
    }

    const existingSeat = await this.prisma.roomSeat.findFirst({ where: { roomId, userId } });
    if (existingSeat) return { joined: true, seatNumber: existingSeat.seatNumber };

    // JOIN is always a request to the host. It never directly takes a seat.
    // Queueing is independent of seat availability: all seats may be occupied,
    // locked, or a mixture of both, and an unseated guest can still wait in
    // the queue for the host to bring them up when a seat becomes available.
    if (room.privacy === 'FOLLOWERS_ONLY') {
      const follows = await this.prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: userId, followingId: room.hostId } },
      });
      if (!follows) throw new ForbiddenException('Only followers of the host can request a seat in this room');
    }

    // INVITE_ONLY requires a host invitation before the user may enter the
    // queue. A user who already accepted a host invitation is represented by
    // an ACCEPTED request and is already in the queue.
    const acceptedInvite = await this.prisma.seatRequest.findFirst({
      where: { roomId, userId, status: 'ACCEPTED', invitedByHost: true },
    });
    if (acceptedInvite) {
      return { requested: true, requestId: acceptedInvite.id, waitingForSeat: true, invited: true };
    }

    if (room.privacy === 'INVITE_ONLY') {
      const invite = await this.prisma.seatRequest.findFirst({
        where: { roomId, userId, status: 'PENDING', invitedByHost: true },
      });
      if (!invite) throw new ForbiddenException('You must be invited to request a seat in this room');
    }

    const existingPending = await this.prisma.seatRequest.findFirst({
      where: { roomId, userId, status: 'PENDING', invitedByHost: false },
    });
    if (existingPending) {
      return { requested: true, requestId: existingPending.id, waitingForSeat: true };
    }

    const request = await this.prisma.seatRequest.create({
      data: { roomId, userId, invitedByHost: false },
    });
    this.emitRoomState(roomId, 'SEAT_REQUESTED', userId, { requestId: request.id });
    return { requested: true, requestId: request.id, waitingForSeat: true };
  }

  private async assertHostOrModerator(roomId: string, userId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId === userId) return room;
    const isMod = await this.prisma.roomModerator.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!isMod) throw new ForbiddenException('Requires host or moderator');
    return room;
  }

  async requestSeat(roomId: string, userId: string, seatNumber: number) {
    // Unseated guests do not bypass the host queue by tapping a seat.
    // Queueing is allowed regardless of whether that seat is occupied, locked,
    // or currently empty. The host decides the actual seat when approving.
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { seatCount: true } });
    if (!room || !Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber >= room.seatCount) {
      throw new BadRequestException('Invalid seat number');
    }
    return this.joinRequest(roomId, userId);
  }

  private async assignSeat(roomId: string, userId: string, seatNumber: number) {
    const lockedSeat = await this.prisma.roomSeatLock.findUnique({ where: { roomId_seatNumber: { roomId, seatNumber } } });
    if (lockedSeat) throw new ForbiddenException('This seat is locked by the host');
    try {
      const seat = await this.prisma.roomSeat.create({ data: { roomId, userId, seatNumber } });
      this.emitRoomState(roomId, 'SEAT_JOINED', userId, { seatNumber });
      return seat;
    } catch {
      throw new BadRequestException('Seat already taken or you already hold a seat in this room');
    }
  }

  async moveSeat(roomId: string, actorId: string, targetUserId: string, seatNumber: number) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room || room.status !== 'OPEN') throw new NotFoundException('Room not open');
    if (!Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber >= room.seatCount) throw new BadRequestException('Invalid seat number');
    if (room.hostId === targetUserId && seatNumber !== 0) throw new BadRequestException('The host must remain in seat 1');
    if (seatNumber === 0 && targetUserId !== room.hostId) throw new BadRequestException('Seat 1 belongs to the host');

    if (targetUserId !== actorId) {
      await this.assertHostOrModerator(roomId, actorId);
      // A moderator can manage ordinary guests, but cannot move the host or
      // another moderator. The host can manage moderators. Keep this check on
      // the server so the permission boundary cannot be bypassed by calling
      // the API directly instead of using the mobile action sheet.
      if (targetUserId !== room.hostId && room.hostId !== actorId) {
        const targetIsModerator = await this.prisma.roomModerator.findUnique({
          where: { roomId_userId: { roomId, userId: targetUserId } },
        });
        if (targetIsModerator) throw new ForbiddenException('Moderators cannot move another moderator');
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.roomSeat.findUnique({ where: { roomId_userId: { roomId, userId: targetUserId } } });
      if (!current) throw new BadRequestException('User is not seated in this room');
      if (current.seatNumber === seatNumber) return { updated: current, fromSeat: current.seatNumber };
      const destination = await tx.roomSeat.findUnique({ where: { roomId_seatNumber: { roomId, seatNumber } } });
      if (destination) throw new BadRequestException('That seat is already occupied');

      const destinationLock = await tx.roomSeatLock.findUnique({
        where: { roomId_seatNumber: { roomId, seatNumber } },
      });
      // A host/moderator explicitly moving a guest can open a locked seat.
      // A guest moving themselves may only move into a seat the host has
      // already unlocked.
      if (destinationLock && targetUserId === actorId) {
        throw new ForbiddenException('That seat is locked by the host');
      }
      if (destinationLock && targetUserId !== actorId) {
        await tx.roomSeatLock.delete({ where: { id: destinationLock.id } });
      }

      const updated = await tx.roomSeat.update({ where: { id: current.id }, data: { seatNumber } });
      if (current.seatNumber > 0) {
        await tx.roomSeatLock.upsert({
          where: { roomId_seatNumber: { roomId, seatNumber: current.seatNumber } },
          update: {},
          create: { roomId, seatNumber: current.seatNumber },
        });
      }
      return { updated, fromSeat: current.seatNumber };
    }).then((result) => {
      this.emitRoomState(roomId, 'SEAT_MOVED', targetUserId, {
        fromSeat: result.fromSeat,
        seatNumber: result.updated.seatNumber,
      });
      return result.updated;
    });
  }

  async setSeatLocked(roomId: string, actorId: string, seatNumber: number, locked: boolean) {
    await this.assertHostOrModerator(roomId, actorId);
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { seatCount: true } });
    if (!room || !Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber >= room.seatCount) {
      throw new BadRequestException('Invalid seat number');
    }
    if (locked) {
      await this.prisma.roomSeatLock.upsert({
        where: { roomId_seatNumber: { roomId, seatNumber } },
        update: {},
        create: { roomId, seatNumber },
      });
    } else {
      await this.prisma.roomSeatLock.deleteMany({ where: { roomId, seatNumber } });
    }
    await this.logModeration(actorId, locked ? 'LOCK_SEAT' : 'UNLOCK_SEAT', roomId);
    this.emitRoomState(roomId, locked ? 'SEAT_LOCKED' : 'SEAT_UNLOCKED', actorId, { seatNumber, locked });
    return { seatNumber, locked };
  }

  // Host-initiated half of the INVITE_ONLY flow — the host (or a
  // moderator) creates a pending invite for a specific user, who then
  // accepts it via acceptInvite(). INVITE_ONLY users cannot create a
  // normal seat request; only a host-created invite can be accepted.
  async inviteToSeat(roomId: string, actorId: string, targetUserId: string) {
    const room = await this.assertHostOrModerator(roomId, actorId);
    if (room.status !== 'OPEN') throw new BadRequestException('Room is closed');
    if (await this.moderation.isBanned('ROOM', roomId, targetUserId)) {
      throw new BadRequestException('Cannot invite a banned user');
    }
    // Either direction: a host can't pull in someone they've blocked, and
    // can't invite someone who blocked them.
    await assertNotBlocked(this.prisma, actorId, targetUserId, "You can't invite this user");
    const existingInvite = await this.prisma.seatRequest.findFirst({
      where: { roomId, userId: targetUserId, status: 'PENDING', invitedByHost: true },
    });
    if (existingInvite) return existingInvite;

    // An ordinary queue request and a host invitation are intentionally
    // separate. The host may invite someone who is already waiting; the
    // invitation can then be accepted from Party without taking a seat.
    return this.prisma.seatRequest.create({
      data: { roomId, userId: targetUserId, invitedByHost: true },
    });
  }

  async acceptInvite(roomId: string, userId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const room = await tx.partyRoom.findUnique({ where: { id: roomId } });
      if (!room || room.status !== 'OPEN') throw new NotFoundException('Room not open');
      if (room.locked) throw new BadRequestException('Room is locked');
      if (await this.moderation.isBanned('ROOM', roomId, userId)) {
        throw new ForbiddenException('You are banned from this room');
      }

      const invite = await tx.seatRequest.findFirst({
        where: { roomId, userId, status: 'PENDING', invitedByHost: true },
      });
      if (!invite) throw new NotFoundException('No pending invite for you in this room');

      // If the person was already waiting in the normal queue, the invitation
      // should not create a duplicate queue row. The accepted host invitation
      // becomes the single request the host will approve.
      await tx.seatRequest.updateMany({
        where: {
          roomId,
          userId,
          status: 'PENDING',
          invitedByHost: false,
        },
        data: { status: 'CANCELLED', decidedAt: new Date() },
      });

      const existingSeat = await tx.roomSeat.findFirst({ where: { roomId, userId } });
      if (existingSeat) {
        await tx.seatRequest.update({
          where: { id: invite.id },
          data: { status: 'APPROVED', decidedAt: new Date() },
        });
        return { roomId, userId, requestId: invite.id, seated: true, seatNumber: existingSeat.seatNumber };
      }

      // Accepting an invitation does NOT bypass the host-controlled seat
      // queue. This is important because guest seats start locked and may all
      // be occupied. The invite is converted into an accepted queue request;
      // the host still chooses the exact seat later.
      await tx.seatRequest.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED' },
      });

      return { roomId, userId, requestId: invite.id, seated: false, waitingForSeat: true };
    });

    if (!result.seated) {
      this.emitRoomState(roomId, 'SEAT_REQUESTED', userId, { requestId: result.requestId, invited: true });
    } else {
      this.emitRoomState(roomId, 'SEAT_APPROVED', userId, { seatNumber: result.seatNumber });
    }
    return result;
  }

  async listSeatRequests(roomId: string, actorId: string) {
    await this.assertHostOrModerator(roomId, actorId);
    const requests = await this.prisma.seatRequest.findMany({
      where: {
        roomId,
        status: { in: ['PENDING', 'ACCEPTED'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (requests.length === 0) return [];

    // Raw rows only ever had userId — unusable for an approval UI
    // without knowing who's actually asking. Same batch-lookup pattern
    // used everywhere else in this backend (GiftService.ranking,
    // LiveService.findMyWatchHistory) since SeatRequest has no direct
    // User relation.
    const users = await this.prisma.user.findMany({
      where: { id: { in: requests.map((r) => r.userId) } },
      select: { id: true, displayName: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    return requests.map((r) => ({
      id: r.id,
      userId: r.userId,
      displayName: userById.get(r.userId)?.displayName ?? null,
      createdAt: r.createdAt,
      invited: r.invitedByHost,
      acceptedInvite: r.status === 'ACCEPTED',
    }));
  }

  async approveSeatRequest(roomId: string, actorId: string, requestId: string, seatNumber: number) {
    const room = await this.assertHostOrModerator(roomId, actorId);
    const result = await this.prisma.$transaction(async (tx) => {
      const currentRoom = await tx.partyRoom.findUnique({ where: { id: roomId } });
      if (!currentRoom || currentRoom.status !== 'OPEN') throw new NotFoundException('Room not open');
      if (!Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber >= currentRoom.seatCount) {
        throw new BadRequestException('Invalid seat number');
      }
      const request = await tx.seatRequest.findUnique({ where: { id: requestId } });
      if (!request || request.roomId !== roomId || !['PENDING', 'ACCEPTED'].includes(request.status)) {
        throw new NotFoundException('No such pending request');
      }
      if (await this.moderation.isBanned('ROOM', roomId, request.userId)) {
        throw new ForbiddenException('This user is banned from the room');
      }

      const destination = await tx.roomSeat.findUnique({
        where: { roomId_seatNumber: { roomId, seatNumber } },
      });
      if (destination) throw new BadRequestException('That seat is already occupied');

      // Host approval is the explicit action that opens this seat for the
      // queued guest. Remove its lock atomically with the assignment.
      await tx.roomSeatLock.deleteMany({ where: { roomId, seatNumber } });

      let seat;
      try {
        seat = await tx.roomSeat.create({ data: { roomId, userId: request.userId, seatNumber } });
      } catch {
        throw new BadRequestException('Seat already taken or this user already holds a seat in the room');
      }

      await tx.seatRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED', decidedAt: new Date() },
      });
      return { seat, userId: request.userId, roomTitle: currentRoom.title };
    });

    await this.notifications.notifyOnce(result.userId, 'SEAT_APPROVED', `seat:${requestId}`, {
      roomId,
      roomTitle: result.roomTitle,
      seatNumber,
    });
    this.emitRoomState(roomId, 'SEAT_APPROVED', result.userId, { seatNumber });
    return result.seat;
  }

  async rejectSeatRequest(roomId: string, actorId: string, requestId: string) {
    await this.assertHostOrModerator(roomId, actorId);
    const request = await this.prisma.seatRequest.findUnique({ where: { id: requestId } });
    if (!request || request.roomId !== roomId || !['PENDING', 'ACCEPTED'].includes(request.status)) {
      throw new NotFoundException('No such pending request');
    }
    return this.prisma.seatRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
  }

  async leaveSeat(roomId: string, userId: string) {
    const seat = await this.prisma.roomSeat.findUnique({ where: { roomId_userId: { roomId, userId } } });
    await this.prisma.roomSeat.deleteMany({ where: { roomId, userId } });
    if (seat && seat.seatNumber > 0) {
      await this.prisma.roomSeatLock.upsert({
        where: { roomId_seatNumber: { roomId, seatNumber: seat.seatNumber } },
        update: {},
        create: { roomId, seatNumber: seat.seatNumber },
      });
      this.emitRoomState(roomId, 'SEAT_LOCKED', userId, { seatNumber: seat.seatNumber, locked: true });
    }
    if (seat) this.emitRoomState(roomId, 'SEAT_LEFT', userId, { seatNumber: seat.seatNumber });
    return { left: true };
  }

  // Separate from rejectSeatRequest on purpose — that one requires
  // assertHostOrModerator, correct for a host rejecting someone else's
  // seat request, but wrong here: an invite goes the other direction
  // (host -> guest), so it must be the invited guest themselves who can
  // decline it, not the host.
  async declineInvite(requestId: string, userId: string) {
    const request = await this.prisma.seatRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== userId || request.status !== 'PENDING' || !request.invitedByHost) {
      throw new NotFoundException('No such pending invite');
    }
    return this.prisma.seatRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
  }

  private async assertCanModerateTarget(roomId: string, actorId: string, targetUserId: string) {
    const room = await this.assertHostOrModerator(roomId, actorId);
    if (targetUserId === actorId) throw new BadRequestException('You cannot moderate yourself');
    if (targetUserId === room.hostId) throw new BadRequestException('Cannot moderate the host');
    if (room.hostId !== actorId) {
      const targetIsModerator = await this.prisma.roomModerator.findUnique({
        where: { roomId_userId: { roomId, userId: targetUserId } },
      });
      if (targetIsModerator) throw new ForbiddenException('Moderators cannot moderate another moderator');
    }
    return room;
  }

  async removeGuest(roomId: string, actorId: string, targetUserId: string) {
    const room = await this.assertCanModerateTarget(roomId, actorId, targetUserId);
    if (targetUserId === room.hostId) throw new BadRequestException('Cannot remove the host');
    const removedSeat = await this.prisma.roomSeat.findUnique({ where: { roomId_userId: { roomId, userId: targetUserId } } });
    const removed = await this.prisma.roomSeat.deleteMany({ where: { roomId, userId: targetUserId } });
    if (removed.count > 0 && removedSeat && removedSeat.seatNumber > 0) {
      await this.prisma.roomSeatLock.upsert({
        where: { roomId_seatNumber: { roomId, seatNumber: removedSeat.seatNumber } },
        update: {},
        create: { roomId, seatNumber: removedSeat.seatNumber },
      });
      this.emitRoomState(roomId, 'SEAT_LOCKED', actorId, { seatNumber: removedSeat.seatNumber, locked: true });
      this.emitRoomState(roomId, 'SEAT_LEFT', targetUserId, { seatNumber: removedSeat.seatNumber });
    }
    await this.logModeration(actorId, 'KICK', roomId, targetUserId);
    this.emitModeration(roomId, 'KICK', actorId, targetUserId);
    return { removed: removed.count > 0 };
  }

  async addModerator(roomId: string, actorId: string, targetUserId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId !== actorId) throw new ForbiddenException('Only the host can add moderators');
    await this.prisma.roomModerator.upsert({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      update: {},
      create: { roomId, userId: targetUserId },
    });
    await this.logModeration(actorId, 'ADD_MODERATOR', roomId, targetUserId);
    this.emitRoomState(roomId, 'MODERATOR_CHANGED', targetUserId, { moderator: true });
    return { added: true };
  }

  async removeModerator(roomId: string, actorId: string, targetUserId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId !== actorId) throw new ForbiddenException('Only the host can remove moderators');
    await this.prisma.roomModerator.deleteMany({ where: { roomId, userId: targetUserId } });
    await this.logModeration(actorId, 'REMOVE_MODERATOR', roomId, targetUserId);
    this.emitRoomState(roomId, 'MODERATOR_CHANGED', targetUserId, { moderator: false });
    return { removed: true };
  }

  async setMode(roomId: string, actorId: string, mode: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId !== actorId) throw new ForbiddenException('Only the host can change room mode');
    if (room.status !== 'OPEN') throw new BadRequestException('Room is closed');
    if (mode !== 'VIDEO' && mode !== 'AUDIO') throw new BadRequestException('mode must be VIDEO or AUDIO');
    const updated = await this.prisma.partyRoom.update({ where: { id: roomId }, data: { mode: mode as any } });
    this.emitRoomState(roomId, 'MODE_CHANGED', undefined, { mode: updated.mode });
    return { mode: updated.mode };
  }

  async setSeatCount(roomId: string, actorId: string, seatCount: number) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId !== actorId) throw new ForbiddenException('Only the host can change seat count');
    if (![4, 6, 9, 12].includes(seatCount)) throw new BadRequestException('seatCount must be 4, 6, 9, or 12');
    if (seatCount < room.seatCount) {
      const occupied = await this.prisma.roomSeat.findFirst({ where: { roomId, seatNumber: { gte: seatCount } } });
      if (occupied) throw new BadRequestException('Remove guests from higher seats first');
    }
    if (seatCount < room.seatCount) {
      await this.prisma.roomSeatLock.deleteMany({ where: { roomId, seatNumber: { gte: seatCount } } });
    } else if (seatCount > room.seatCount) {
      await this.prisma.roomSeatLock.createMany({
        data: Array.from({ length: seatCount - room.seatCount }, (_, index) => ({
          roomId,
          seatNumber: room.seatCount + index,
        })),
        skipDuplicates: true,
      });
    }
    const updated = await this.prisma.partyRoom.update({ where: { id: roomId }, data: { seatCount } });
    this.emitRoomState(roomId, 'SEAT_COUNT_CHANGED', undefined, { seatCount: updated.seatCount });
    return { seatCount: updated.seatCount };
  }

  async lock(roomId: string, actorId: string, locked: boolean) {
    await this.assertHostOrModerator(roomId, actorId);
    await this.prisma.partyRoom.update({ where: { id: roomId }, data: { locked } });
    await this.logModeration(actorId, locked ? 'LOCK_ROOM' : 'UNLOCK_ROOM', roomId);
    return { locked };
  }

  async close(roomId: string, hostId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId !== hostId) throw new ForbiddenException('Only the host can close the room');
    return this.finishClose(room);
  }

  // Closes a room whose host has gone away (app killed, phone died).
  async closeAbandoned(roomId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    return room ? this.finishClose(room) : null;
  }

  // Idempotent: closing a room that is already closed returns it untouched, so a
  // repeated call (or the sweeper racing the host) can't rewrite the close time.
  private async finishClose(room: { id: string; providerChannel: string; status: string }) {
    if (room.status === 'CLOSED') return this.prisma.partyRoom.findUniqueOrThrow({ where: { id: room.id } });
    await this.rtc.destroyChannel(room.providerChannel);
    return this.prisma.partyRoom.update({
      where: { id: room.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  }

  async muteGuest(roomId: string, actorId: string, targetUserId: string) {
    await this.assertCanModerateTarget(roomId, actorId, targetUserId);
    await this.logModeration(actorId, 'MUTE', roomId, targetUserId);
    this.emitModeration(roomId, 'MUTE', actorId, targetUserId);
    return { muted: true };
  }

  async unmuteGuest(roomId: string, actorId: string, targetUserId: string) {
    await this.assertCanModerateTarget(roomId, actorId, targetUserId);
    await this.logModeration(actorId, 'UNMUTE', roomId, targetUserId);
    this.emitModeration(roomId, 'UNMUTE', actorId, targetUserId);
    return { muted: false };
  }

  async banGuest(roomId: string, actorId: string, targetUserId: string) {
    await this.assertCanModerateTarget(roomId, actorId, targetUserId);
    const removedSeat = await this.prisma.roomSeat.findUnique({ where: { roomId_userId: { roomId, userId: targetUserId } } });
    const removed = await this.prisma.roomSeat.deleteMany({ where: { roomId, userId: targetUserId } });
    if (removed.count > 0 && removedSeat && removedSeat.seatNumber > 0) {
      await this.prisma.roomSeatLock.upsert({
        where: { roomId_seatNumber: { roomId, seatNumber: removedSeat.seatNumber } },
        update: {},
        create: { roomId, seatNumber: removedSeat.seatNumber },
      });
      this.emitRoomState(roomId, 'SEAT_LOCKED', actorId, { seatNumber: removedSeat.seatNumber, locked: true });
      this.emitRoomState(roomId, 'SEAT_LEFT', targetUserId, { seatNumber: removedSeat.seatNumber });
    }
    await this.logModeration(actorId, 'BAN', roomId, targetUserId);
    this.emitModeration(roomId, 'BAN', actorId, targetUserId);
    return { banned: true, removed: removed.count > 0 };
  }

  async unbanGuest(roomId: string, actorId: string, targetUserId: string) {
    await this.assertHostOrModerator(roomId, actorId);
    await this.logModeration(actorId, 'UNBAN', roomId, targetUserId);
    this.emitModeration(roomId, 'UNBAN', actorId, targetUserId);
    return { banned: false };
  }

  // Mid-session re-theme. Host only (a moderator runs the room, but the
  // stage's look is the host's call). Unlike create(), which silently
  // drops a bad color, this is an explicit edit, so a bad value is a 400.
  async setTheme(roomId: string, actorId: string, themeColor: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId !== actorId) throw new ForbiddenException('Only the host can change the room theme');
    if (room.status !== 'OPEN') throw new BadRequestException('Room is closed');
    if (typeof themeColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(themeColor)) {
      throw new BadRequestException('themeColor must be a #RRGGBB hex color');
    }

    const updated = await this.prisma.partyRoom.update({ where: { id: roomId }, data: { themeColor } });

    try {
      this.realtime.broadcastRoomTheme(roomId, { roomId, themeColor });
    } catch {
      /* clients pick it up from the polled room details */
    }
    return { themeColor: updated.themeColor };
  }

  async chatHistory(roomId: string, limit?: number, before?: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { id: true } });
    if (!room) throw new NotFoundException('Room not found');
    return fetchChatHistory(this.prisma, 'ROOM', roomId, { limit, before });
  }

  listOpen() {
    return this.prisma.partyRoom.findMany({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, hostId: true, title: true, privacy: true, seatCount: true,
        locked: true, status: true, countryCode: true, createdAt: true,
        category: true, themeColor: true, mode: true,
      },
    });
  }

  // The audit row is the source of truth; the push is best-effort and must
  // never fail the moderation action itself.
  private emitRoomState(
    roomId: string,
    action: string,
    targetUserId?: string,
    extra: Record<string, unknown> = {},
  ) {
    try {
      this.realtime.broadcastRoomState(roomId, { roomId, action, targetUserId, ...extra });
    } catch {
      /* REST polling remains the recovery path if realtime is unavailable. */
    }
  }

  private emitModeration(
    roomId: string,
    action: 'KICK' | 'MUTE' | 'UNMUTE' | 'BAN' | 'UNBAN',
    actorId: string,
    targetUserId: string,
  ) {
    try {
      this.realtime.broadcastRoomModeration(roomId, { roomId, action, targetUserId, actorId });
    } catch {
      /* clients still converge via the polled room details and the REST join */
    }
  }

  private async logModeration(
    actorId: string,
    actionType: 'KICK' | 'ADD_MODERATOR' | 'REMOVE_MODERATOR' | 'LOCK_ROOM' | 'UNLOCK_ROOM' | 'MUTE' | 'UNMUTE' | 'BAN' | 'UNBAN',
    roomId: string,
    targetUserId?: string,
  ) {
    await this.prisma.moderationAction.create({
      data: { actorId, actionType, context: 'ROOM', contextId: roomId, targetUserId },
    });
  }
}
