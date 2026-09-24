import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ModerationService } from '../moderation/moderation.service';
import { ModerationActionType, RoomPrivacy } from '@prisma/client';
import { ROOM_SEAT_COUNTS, snapSeatCount } from './room-input';
import { RTC_PROVIDER } from '../live/live.service';
import type { RtcProvider } from '../live/providers/rtc-provider.interface';
import { fetchChatHistory } from '../common/chat-history';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotBlocked } from '../common/blocks';
import { publicName } from '../common/public-name';

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
        seatCount: snapSeatCount(seatCount),
        countryCode,
        providerChannel: channelName,
        category,
        themeColor: themeColor && /^#[0-9A-Fa-f]{6}$/.test(themeColor) ? themeColor : null,
        mode: mode === 'VIDEO' ? 'VIDEO' : 'AUDIO',
      },
    });
    // Host occupies seat 0 by convention. Guest seats start EMPTY and OPEN.
    // A guest may take any empty/unlocked seat directly; the waiting queue is
    // used when there is no vacant unlocked seat (or when the guest explicitly
    // presses Join queue). Locks are explicit host/moderator actions only.
    await this.prisma.roomSeat.create({ data: { roomId: room.id, userId: hostId, seatNumber: 0 } });
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

  // viewerId is the authenticated caller: profileGiftCoins is THEIR lifetime
  // gift total, so the header can show it without a second request.
  async getRoomDetails(roomId: string, viewerId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');

    const seats = await this.prisma.roomSeat.findMany({ where: { roomId }, orderBy: { seatNumber: 'asc' } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: seats.map((s) => s.userId) } },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    // assertHostOrModerator already lets a designated moderator do
    // everything a host can (approve requests, kick, ban) — but nothing
    // ever told the client who the moderators actually are, so mobile
    // could only ever show those controls to the literal host, hiding
    // real capabilities a moderator genuinely has.
    const [moderators, mutedUserIds, locks, giftAgg, giftByRecipient] = await Promise.all([
      this.prisma.roomModerator.findMany({ where: { roomId }, select: { userId: true } }),
      this.moderation.mutedUserIds('ROOM', roomId),
      this.prisma.roomSeatLock.findMany({ where: { roomId }, select: { seatNumber: true } }),
      this.prisma.giftTransaction.aggregate({ where: { context: 'ROOM', contextId: roomId }, _sum: { coinAmount: true } }),
      this.prisma.giftTransaction.groupBy({ by: ['recipientId'], where: { context: 'ROOM', contextId: roomId }, _sum: { coinAmount: true } }),
    ]);
    const profileGiftAgg = await this.prisma.giftTransaction.aggregate({
      where: { recipientId: viewerId },
      _sum: { coinAmount: true },
    });
    const seatGiftCoins = Object.fromEntries(giftByRecipient.map((row) => [row.recipientId, row._sum.coinAmount ?? 0]));
    const lockedNumbers = new Set(locks.map((l) => l.seatNumber));

    return {
      ...room,
      moderatorIds: moderators.map((m) => m.userId),
      mutedUserIds,
      lockedSeatNumbers: [...lockedNumbers],
      giftCoins: giftAgg._sum.coinAmount ?? 0,
      seatGiftCoins,
      profileGiftCoins: profileGiftAgg._sum.coinAmount ?? 0,
      seats: seats.map((s) => ({
        seatNumber: s.seatNumber,
        userId: s.userId,
        displayName: publicName(userById.get(s.userId)?.displayName, s.userId),
        avatarUrl: userById.get(s.userId)?.avatarUrl ?? null,
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
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room || room.status !== 'OPEN') throw new NotFoundException('Room not open');
    if (!Number.isInteger(seatNumber) || seatNumber < 0 || seatNumber >= room.seatCount) {
      throw new BadRequestException('Invalid seat number');
    }
    if (room.locked) throw new BadRequestException('Room is locked');
    if (await this.moderation.isBanned('ROOM', roomId, userId)) {
      throw new ForbiddenException('You are banned from this room');
    }
    if (room.privacy === 'FOLLOWERS_ONLY') {
      const follows = await this.prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: userId, followingId: room.hostId } },
      });
      if (!follows) throw new ForbiddenException('Only followers of the host can join this room');
    }
    if (room.privacy === 'INVITE_ONLY') {
      const invite = await this.prisma.seatRequest.findFirst({
        where: { roomId, userId, status: { in: ['PENDING', 'ACCEPTED'] }, invitedByHost: true },
      });
      if (!invite) throw new ForbiddenException('You must be invited to join this room');
    }

    const existingSeat = await this.prisma.roomSeat.findFirst({ where: { roomId, userId } });
    if (existingSeat) return { joined: true, seatNumber: existingSeat.seatNumber };

    const result = await this.prisma.$transaction(async (tx) => {
      const occupied = await tx.roomSeat.findUnique({ where: { roomId_seatNumber: { roomId, seatNumber } } });
      const lock = await tx.roomSeatLock.findUnique({ where: { roomId_seatNumber: { roomId, seatNumber } } });
      if (occupied || lock) return null;
      const seat = await tx.roomSeat.create({ data: { roomId, userId, seatNumber } });
      await tx.seatRequest.updateMany({
        where: { roomId, userId, status: { in: ['PENDING', 'ACCEPTED'] }, invitedByHost: false },
        data: { status: 'APPROVED', decidedAt: new Date() },
      });
      return seat;
    });

    if (result) {
      this.emitRoomState(roomId, 'SEAT_JOINED', userId, { seatNumber: result.seatNumber });
      return { joined: true, seatNumber: result.seatNumber };
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

      // Moving someone frees the old seat. It stays OPEN unless the host
      // explicitly locks it later.
      const updated = await tx.roomSeat.update({ where: { id: current.id }, data: { seatNumber } });
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
      const occupied = await this.prisma.roomSeat.findUnique({ where: { roomId_seatNumber: { roomId, seatNumber } } });
      if (occupied) throw new BadRequestException('You cannot lock an occupied seat');
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
  async inviteCandidates(roomId: string, actorId: string, category: 'friends' | 'fans' | 'agency', search?: string) {
    await this.assertHostOrModerator(roomId, actorId);
    const needle = (search ?? '').trim();
    const base = needle ? { displayName: { contains: needle, mode: 'insensitive' as const } } : {};
    let userIds: string[] = [];
    if (category === 'fans') {
      const rows = await this.prisma.follow.findMany({ where: { followingId: actorId }, select: { followerId: true } });
      userIds = rows.map((r) => r.followerId);
    } else if (category === 'friends') {
      const [following, followers] = await Promise.all([
        this.prisma.follow.findMany({ where: { followerId: actorId }, select: { followingId: true } }),
        this.prisma.follow.findMany({ where: { followingId: actorId }, select: { followerId: true } }),
      ]);
      const followerSet = new Set(followers.map((r) => r.followerId));
      userIds = following.map((r) => r.followingId).filter((id) => followerSet.has(id));
    } else {
      const membership = await this.prisma.agencyMembership.findFirst({ where: { creatorId: actorId, status: 'ACTIVE' } });
      if (!membership) return [];
      const rows = await this.prisma.agencyMembership.findMany({ where: { agencyId: membership.agencyId, status: 'ACTIVE', creatorId: { not: actorId } }, select: { creatorId: true } });
      userIds = rows.map((r) => r.creatorId);
    }
    if (!userIds.length) return [];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds }, ...base }, select: { id: true, displayName: true, avatarUrl: true }, orderBy: { displayName: 'asc' }, take: 100 });
    return users;
  }

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
    if (existingInvite) {
      // The host tapped Invite again: the first notification may have been missed
      // (app in the background, socket down), so send it again, at most every 15 s.
      if (Date.now() - new Date(existingInvite.createdAt).getTime() > 15_000) {
        const host = await this.prisma.user.findUnique({ where: { id: actorId }, select: { displayName: true } });
        await this.notifications.notify(targetUserId, 'SYSTEM', {
          event: 'PARTY_INVITE',
          roomId,
          roomTitle: room.title,
          hostDisplayName: publicName(host?.displayName, actorId),
          requestId: existingInvite.id,
        });
      }
      return existingInvite;
    }

    // An ordinary queue request and a host invitation are intentionally
    // separate. The host may invite someone who is already waiting; the
    // invitation can then be accepted from Party without taking a seat.
    const invite = await this.prisma.seatRequest.create({
      data: { roomId, userId: targetUserId, invitedByHost: true },
    });
    const host = await this.prisma.user.findUnique({ where: { id: actorId }, select: { displayName: true } });
    await this.notifications.notify(targetUserId, 'SYSTEM', {
      event: 'PARTY_INVITE',
      roomId,
      roomTitle: room.title,
      hostDisplayName: publicName(host?.displayName, actorId),
      requestId: invite.id,
    });
    return invite;
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

      await tx.seatRequest.updateMany({
        where: { roomId, userId, status: 'PENDING', invitedByHost: false },
        data: { status: 'CANCELLED', decidedAt: new Date() },
      });

      const existingSeat = await tx.roomSeat.findFirst({ where: { roomId, userId } });
      if (existingSeat) {
        await tx.seatRequest.update({ where: { id: invite.id }, data: { status: 'APPROVED', decidedAt: new Date() } });
        return { roomId, userId, requestId: invite.id, seated: true, seatNumber: existingSeat.seatNumber };
      }

      // An invitation gets immediate entry when a vacant UNLOCKED guest seat
      // exists. Otherwise it becomes a normal queue entry for the host.
      const [occupiedRows, lockedRows] = await Promise.all([
        tx.roomSeat.findMany({ where: { roomId }, select: { seatNumber: true } }),
        tx.roomSeatLock.findMany({ where: { roomId }, select: { seatNumber: true } }),
      ]);
      const taken = new Set([...occupiedRows, ...lockedRows].map((r) => r.seatNumber));
      let seatNumber: number | null = null;
      for (let n = 1; n < room.seatCount; n++) {
        if (!taken.has(n)) { seatNumber = n; break; }
      }

      if (seatNumber != null) {
        const seat = await tx.roomSeat.create({ data: { roomId, userId, seatNumber } });
        await tx.seatRequest.update({ where: { id: invite.id }, data: { status: 'APPROVED', decidedAt: new Date() } });
        return { roomId, userId, requestId: invite.id, seated: true, seatNumber: seat.seatNumber };
      }

      await tx.seatRequest.update({ where: { id: invite.id }, data: { status: 'ACCEPTED' } });
      return { roomId, userId, requestId: invite.id, seated: false, waitingForSeat: true };
    });

    if (result.seated) {
      this.emitRoomState(roomId, 'SEAT_JOINED', userId, { seatNumber: result.seatNumber, invited: true });
    } else {
      this.emitRoomState(roomId, 'SEAT_REQUESTED', userId, { requestId: result.requestId, invited: true });
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
      displayName: publicName(userById.get(r.userId)?.displayName, r.userId),
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
    const updated = await this.prisma.seatRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
    // The requester used to never find out; they sat waiting forever.
    this.emitRoomState(roomId, 'SEAT_REJECTED', request.userId, { requestId });
    return updated;
  }

  async leaveSeat(roomId: string, userId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { hostId: true } });
    if (!room) throw new NotFoundException('Room not found');
    // The host's seat is the stage. Leaving it would leave a room with no host
    // tile and no one able to take seat 1; the host ends the party with Close.
    if (room.hostId === userId) throw new BadRequestException('The host stays on seat 1. Close the room to leave.');
    return this.releaseSeat(roomId, userId);
  }

  // Frees a guest's seat and tells the room. Shared by leaveSeat and the
  // reaper (a guest whose app died must not hold a seat forever).
  async releaseSeat(roomId: string, userId: string) {
    const seat = await this.prisma.roomSeat.findUnique({ where: { roomId_userId: { roomId, userId } } });
    await this.prisma.roomSeat.deleteMany({ where: { roomId, userId } });
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
    if (removed.count > 0 && removedSeat) {
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
    if (!(ROOM_SEAT_COUNTS as readonly number[]).includes(seatCount)) {
      throw new BadRequestException(`seatCount must be one of: ${ROOM_SEAT_COUNTS.join(', ')}`);
    }
    if (seatCount < room.seatCount) {
      const occupied = await this.prisma.roomSeat.findFirst({ where: { roomId, seatNumber: { gte: seatCount } } });
      if (occupied) throw new BadRequestException('Remove guests from higher seats first');
    }
    if (seatCount < room.seatCount) {
      await this.prisma.roomSeatLock.deleteMany({ where: { roomId, seatNumber: { gte: seatCount } } });
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
    const closed = await this.prisma.partyRoom.update({
      where: { id: room.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    // Everyone still inside must be told. Before, guests sat in a dead,
    // silent room until they left on their own.
    try {
      this.realtime.broadcastRoomClosed(room.id, { roomId: room.id });
    } catch {
      /* clients also see status CLOSED on their next room-details fetch */
    }
    // Open requests/invites for a closed room are meaningless now.
    try {
      await this.prisma.seatRequest.updateMany({
        where: { roomId: room.id, status: { in: ['PENDING', 'ACCEPTED'] } },
        data: { status: 'CANCELLED', decidedAt: new Date() },
      });
    } catch {
      /* best effort — findMyInvites already hides closed rooms */
    }
    return closed;
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
    if (removed.count > 0 && removedSeat) {
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
    void this.broadcastRoomState(roomId, action, targetUserId, extra);
  }

  // Seat events carry the person's name so every client can write "Ada took a seat"
  // straight away. Clients used to look the joiner up in the seat list from before the
  // event, where they are not yet listed, and printed "Guest".
  private static readonly NAMED_ACTIONS = new Set(['SEAT_JOINED', 'SEAT_APPROVED', 'SEAT_REQUESTED', 'SEAT_LEFT']);
  private async broadcastRoomState(roomId: string, action: string, targetUserId: string | undefined, extra: Record<string, unknown>) {
    try {
      let payload: Record<string, unknown> = { ...extra };
      if (targetUserId && payload.displayName === undefined && RoomsService.NAMED_ACTIONS.has(action)) {
        try {
          const user = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { displayName: true } });
          payload = { ...payload, displayName: publicName(user?.displayName, targetUserId) };
        } catch { /* the event still goes out; the app falls back to a profile lookup */ }
      }
      this.realtime.broadcastRoomState(roomId, { roomId, action, targetUserId, ...payload });
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
    actionType: ModerationActionType,
    roomId: string,
    targetUserId?: string,
  ) {
    await this.prisma.moderationAction.create({
      data: { actorId, actionType, context: 'ROOM', contextId: roomId, targetUserId },
    });
  }
}
