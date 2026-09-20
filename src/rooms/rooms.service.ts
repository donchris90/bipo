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
    // Host occupies seat 0 by convention.
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
    const moderators = await this.prisma.roomModerator.findMany({ where: { roomId }, select: { userId: true } });
    const mutedUserIds = await this.moderation.mutedUserIds('ROOM', roomId);

    return {
      ...room,
      moderatorIds: moderators.map((m) => m.userId),
      mutedUserIds,
      seats: seats.map((s) => ({
        seatNumber: s.seatNumber,
        userId: s.userId,
        displayName: userById.get(s.userId)?.displayName ?? null,
        joinedAt: s.joinedAt,
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
    if (room.locked) throw new BadRequestException('Room is locked');
    if (seatNumber < 0 || seatNumber >= room.seatCount) throw new BadRequestException('Invalid seat number');
    if (await this.moderation.isBanned('ROOM', roomId, userId)) {
      throw new ForbiddenException('You are banned from this room');
    }

    if (room.privacy === 'FOLLOWERS_ONLY') {
      const follows = await this.prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: userId, followingId: room.hostId } },
      });
      if (!follows) throw new ForbiddenException('Only followers of the host can join this room');
      return this.assignSeat(roomId, userId, seatNumber);
    }

    if (room.privacy === 'PRIVATE' || room.privacy === 'INVITE_ONLY') {
      // Both privacy levels use the same request→approve flow here; the
      // spec distinguishes them (INVITE_ONLY implies only pre-invited users
      // can request at all), but there's no invite-list concept to check
      // against yet — see inviteToSeat() below for the host-initiated half
      // of that, which is the part that's actually built. A user calling
      // this directly on an INVITE_ONLY room creates a normal pending
      // request rather than being blocked outright; tightening that is the
      // natural next increment once an actual invite list matters.
      const existingPending = await this.prisma.seatRequest.findFirst({
        where: { roomId, userId, status: 'PENDING' },
      });
      if (existingPending) return existingPending;

      return this.prisma.seatRequest.create({ data: { roomId, userId, invitedByHost: false } });
    }

    // PUBLIC — immediate join, unchanged from before.
    return this.assignSeat(roomId, userId, seatNumber);
  }

  private async assignSeat(roomId: string, userId: string, seatNumber: number) {
    try {
      return await this.prisma.roomSeat.create({ data: { roomId, userId, seatNumber } });
    } catch {
      throw new BadRequestException('Seat already taken or you already hold a seat in this room');
    }
  }

  // Host-initiated half of the INVITE_ONLY flow — the host (or a
  // moderator) creates a pending invite for a specific user, who then
  // accepts it via acceptInvite(). This is what actually makes
  // INVITE_ONLY behave differently from PRIVATE right now.
  async inviteToSeat(roomId: string, actorId: string, targetUserId: string) {
    await this.assertHostOrModerator(roomId, actorId);
    if (await this.moderation.isBanned('ROOM', roomId, targetUserId)) {
      throw new BadRequestException('Cannot invite a banned user');
    }
    // Either direction: a host can't pull in someone they've blocked, and
    // can't invite someone who blocked them.
    await assertNotBlocked(this.prisma, actorId, targetUserId, "You can't invite this user");
    const existingPending = await this.prisma.seatRequest.findFirst({
      where: { roomId, userId: targetUserId, status: 'PENDING' },
    });
    if (existingPending) return existingPending;
    return this.prisma.seatRequest.create({ data: { roomId, userId: targetUserId, invitedByHost: true } });
  }

  async acceptInvite(roomId: string, userId: string, seatNumber: number) {
    const invite = await this.prisma.seatRequest.findFirst({
      where: { roomId, userId, status: 'PENDING', invitedByHost: true },
    });
    if (!invite) throw new NotFoundException('No pending invite for you in this room');

    const seat = await this.assignSeat(roomId, userId, seatNumber);
    await this.prisma.seatRequest.update({
      where: { id: invite.id },
      data: { status: 'APPROVED', decidedAt: new Date() },
    });
    return seat;
  }

  async listSeatRequests(roomId: string, actorId: string) {
    await this.assertHostOrModerator(roomId, actorId);
    const requests = await this.prisma.seatRequest.findMany({
      where: { roomId, status: 'PENDING', invitedByHost: false },
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
    }));
  }

  async approveSeatRequest(roomId: string, actorId: string, requestId: string, seatNumber: number) {
    const room = await this.assertHostOrModerator(roomId, actorId);
    const request = await this.prisma.seatRequest.findUnique({ where: { id: requestId } });
    if (!request || request.roomId !== roomId || request.status !== 'PENDING') {
      throw new NotFoundException('No such pending request');
    }

    const seat = await this.assignSeat(roomId, request.userId, seatNumber);
    await this.prisma.seatRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', decidedAt: new Date() },
    });

    // The requester may have left the room screen while waiting — this is
    // how they find out they got the seat.
    await this.notifications.notifyOnce(request.userId, 'SEAT_APPROVED', `seat:${requestId}`, {
      roomId,
      roomTitle: room.title,
      seatNumber,
    });
    return seat;
  }

  async rejectSeatRequest(roomId: string, actorId: string, requestId: string) {
    await this.assertHostOrModerator(roomId, actorId);
    const request = await this.prisma.seatRequest.findUnique({ where: { id: requestId } });
    if (!request || request.roomId !== roomId || request.status !== 'PENDING') {
      throw new NotFoundException('No such pending request');
    }
    return this.prisma.seatRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
  }

  async leaveSeat(roomId: string, userId: string) {
    await this.prisma.roomSeat.deleteMany({ where: { roomId, userId } });
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

  async removeGuest(roomId: string, actorId: string, targetUserId: string) {
    const room = await this.assertHostOrModerator(roomId, actorId);
    if (targetUserId === room.hostId) throw new BadRequestException('Cannot remove the host');
    await this.prisma.roomSeat.deleteMany({ where: { roomId, userId: targetUserId } });
    await this.logModeration(actorId, 'KICK', roomId, targetUserId);
    this.emitModeration(roomId, 'KICK', actorId, targetUserId);
    return { removed: true };
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
    return { added: true };
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
    const room = await this.assertHostOrModerator(roomId, actorId);
    if (targetUserId === room.hostId) throw new BadRequestException('Cannot mute the host');
    await this.logModeration(actorId, 'MUTE', roomId, targetUserId);
    this.emitModeration(roomId, 'MUTE', actorId, targetUserId);
    return { muted: true };
  }

  async unmuteGuest(roomId: string, actorId: string, targetUserId: string) {
    await this.assertHostOrModerator(roomId, actorId);
    await this.logModeration(actorId, 'UNMUTE', roomId, targetUserId);
    this.emitModeration(roomId, 'UNMUTE', actorId, targetUserId);
    return { muted: false };
  }

  async banGuest(roomId: string, actorId: string, targetUserId: string) {
    const room = await this.assertHostOrModerator(roomId, actorId);
    if (targetUserId === room.hostId) throw new BadRequestException('Cannot ban the host');
    await this.prisma.roomSeat.deleteMany({ where: { roomId, userId: targetUserId } });
    await this.logModeration(actorId, 'BAN', roomId, targetUserId);
    this.emitModeration(roomId, 'BAN', actorId, targetUserId);
    return { banned: true };
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
    return this.prisma.partyRoom.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  // The audit row is the source of truth; the push is best-effort and must
  // never fail the moderation action itself.
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
    actionType: 'KICK' | 'ADD_MODERATOR' | 'LOCK_ROOM' | 'UNLOCK_ROOM' | 'MUTE' | 'UNMUTE' | 'BAN' | 'UNBAN',
    roomId: string,
    targetUserId?: string,
  ) {
    await this.prisma.moderationAction.create({
      data: { actorId, actionType, context: 'ROOM', contextId: roomId, targetUserId },
    });
  }
}
