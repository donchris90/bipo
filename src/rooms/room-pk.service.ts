import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  ROOM_PK_COUNTDOWN_MS,
  ROOM_PK_RESULT_MS,
  buildEntrants,
  decideRoomPkResult,
  normalizeRoomPkDuration,
  normalizeRoomPkMode,
  rankEntrants,
  roomPkPhase,
  type RoomPkMode,
} from './room-pk-rules';

export interface StartRoomPkInput {
  mode?: unknown;
  durationSec?: unknown;
  // seatNumber -> "A" | "B", TEAMS only. Omitted = seats alternate A/B.
  sides?: Record<string, unknown> | null;
}

// Multi-guest / Room PK: everyone seated in a party room competes on gifts received while it
// runs. Started and ended by the host; settled by the database clock (see RoomPkReaperService),
// not by any client. Scores are fed by GiftService via economy/room-pk-score.ts.
@Injectable()
export class RoomPkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async start(roomId: string, actorId: string, input: StartRoomPkInput = {}) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.hostId !== actorId) throw new ForbiddenException('Only the host can start a Room PK');
    if (room.status !== 'OPEN') throw new BadRequestException('Room is closed');
    const mode = normalizeRoomPkMode(input.mode);
    const durationSec = normalizeRoomPkDuration(input.durationSec);

    const running = await this.prisma.roomPk.findFirst({ where: { roomId, status: 'ACTIVE' }, select: { id: true } });
    if (running) throw new BadRequestException('A Room PK is already running');

    const seats = await this.prisma.roomSeat.findMany({ where: { roomId }, select: { userId: true, seatNumber: true } });
    const entrants = buildEntrants(seats, mode, input.sides);

    // The battle clock starts after the get-ready countdown; nothing scores before startedAt.
    const startedAt = new Date(Date.now() + ROOM_PK_COUNTDOWN_MS);
    const endsAt = new Date(startedAt.getTime() + durationSec * 1000);
    const created = await this.prisma.roomPk.create({
      data: {
        roomId,
        hostId: actorId,
        mode,
        durationSec,
        startedAt,
        endsAt,
        participants: {
          create: entrants.map((e) => ({ userId: e.userId, seatNumber: e.seatNumber, side: e.side })),
        },
      },
    });
    const state = await this.stateOf(created.id);
    this.broadcast(roomId, 'ROOM_PK_STARTED', state);
    return state;
  }

  // The PK to show in this room right now: the running one, or one that finished a moment ago
  // (so every screen can show the result), else null.
  async current(roomId: string) {
    const room = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { id: true } });
    if (!room) throw new NotFoundException('Room not found');
    const pk = await this.prisma.roomPk.findFirst({
      where: {
        roomId,
        OR: [
          { status: 'ACTIVE' },
          { status: 'SETTLED', settledAt: { gte: new Date(Date.now() - ROOM_PK_RESULT_MS) } },
        ],
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    return pk ? this.stateOf(pk.id) : null;
  }

  // Host ends it early: settled on the scores as they stand.
  async end(roomId: string, actorId: string) {
    const pk = await this.prisma.roomPk.findFirst({ where: { roomId, status: 'ACTIVE' } });
    if (!pk) throw new NotFoundException('No Room PK is running');
    if (pk.hostId !== actorId) throw new ForbiddenException('Only the host can end the Room PK');
    // Still in the get-ready countdown: nothing has been played, so cancel instead of crowning anyone.
    if (pk.startedAt > new Date()) {
      const flipped = await this.prisma.roomPk.updateMany({ where: { id: pk.id, status: 'ACTIVE' }, data: { status: 'CANCELLED', settledAt: new Date() } });
      const state = await this.stateOf(pk.id);
      if (flipped.count === 1) this.broadcast(roomId, 'ROOM_PK_CANCELLED', state);
      return state;
    }
    return this.settle(pk.id, true);
  }

  async settleIfDue(roomPkId: string) {
    return this.settle(roomPkId, false);
  }

  private async settle(roomPkId: string, force: boolean) {
    const settled = await this.prisma.$transaction(async (tx) => {
      const pk = await tx.roomPk.findUnique({ where: { id: roomPkId } });
      if (!pk) throw new NotFoundException('Room PK not found');
      if (pk.status !== 'ACTIVE') return null;
      if (!force && pk.endsAt > new Date()) return null;
      // Flip the status FIRST. Gift scoring is guarded on status ACTIVE, so once this lands no
      // score can change and the winner below is computed from final numbers.
      const flipped = await tx.roomPk.updateMany({
        where: { id: roomPkId, status: 'ACTIVE' },
        data: { status: 'SETTLED', settledAt: new Date() },
      });
      if (flipped.count !== 1) return null;
      const participants = await tx.roomPkParticipant.findMany({ where: { roomPkId } });
      const result = decideRoomPkResult(pk.mode as RoomPkMode, participants);
      await tx.roomPk.update({
        where: { id: roomPkId },
        data: { winnerUserId: result.winnerUserId, winnerSide: result.winnerSide },
      });
      return pk.roomId;
    });
    const state = await this.stateOf(roomPkId);
    if (settled) this.broadcast(state.roomId, 'ROOM_PK_SETTLED', state);
    return state;
  }

  // Called every second by RoomPkReaperService.
  async sweep(now = new Date()) {
    const due = await this.prisma.roomPk.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: now } },
      select: { id: true },
      take: 100,
    });
    for (const pk of due) await this.settleIfDue(pk.id);

    // A room that closed under a running PK: cancel it rather than crown a winner nobody watched.
    const running = await this.prisma.roomPk.findMany({ where: { status: 'ACTIVE' }, select: { id: true, roomId: true }, take: 200 });
    if (running.length === 0) return;
    const open = await this.prisma.partyRoom.findMany({
      where: { id: { in: running.map((r) => r.roomId) }, status: 'OPEN' },
      select: { id: true },
    });
    const openIds = new Set(open.map((r) => r.id));
    for (const pk of running.filter((r) => !openIds.has(r.roomId))) {
      const flipped = await this.prisma.roomPk.updateMany({
        where: { id: pk.id, status: 'ACTIVE' },
        data: { status: 'CANCELLED', settledAt: now },
      });
      if (flipped.count === 1) this.broadcast(pk.roomId, 'ROOM_PK_CANCELLED', await this.stateOf(pk.id));
    }
  }

  private async stateOf(roomPkId: string) {
    const pk = await this.prisma.roomPk.findUnique({ where: { id: roomPkId }, include: { participants: true } });
    if (!pk) throw new NotFoundException('Room PK not found');
    const users = await this.prisma.user.findMany({
      where: { id: { in: pk.participants.map((p) => p.userId) } },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const ranked = rankEntrants(pk.participants);
    const rankOf = new Map(ranked.map((r) => [r.userId, r.rank]));
    const totals = pk.mode === 'TEAMS' ? decideRoomPkResult('TEAMS', pk.participants).sideTotals : null;
    return {
      id: pk.id,
      roomId: pk.roomId,
      hostId: pk.hostId,
      mode: pk.mode,
      status: pk.status,
      // COUNTDOWN (gifts don't count yet) | ACTIVE | ENDED, worked out with the server clock.
      phase: roomPkPhase(pk),
      durationSec: pk.durationSec,
      startedAt: pk.startedAt,
      endsAt: pk.endsAt,
      settledAt: pk.settledAt,
      winnerUserId: pk.winnerUserId,
      winnerSide: pk.winnerSide,
      serverNow: new Date(),
      // BigInt is not JSON-serializable, so scores travel as strings (same as PKBattle).
      sideTotals: totals ? { A: totals.A.toString(), B: totals.B.toString() } : null,
      participants: [...pk.participants]
        .sort((a, b) => (rankOf.get(a.userId)! - rankOf.get(b.userId)!) || a.seatNumber - b.seatNumber)
        .map((p) => ({
          userId: p.userId,
          seatNumber: p.seatNumber,
          side: p.side,
          score: p.score.toString(),
          rank: rankOf.get(p.userId) ?? null,
          displayName: byId.get(p.userId)?.displayName ?? null,
          avatarUrl: byId.get(p.userId)?.avatarUrl ?? null,
        })),
    };
  }

  private broadcast(roomId: string, action: string, state: unknown) {
    try {
      // Rides the existing 'room:state' event every room client already listens to.
      this.realtime.broadcastRoomState(roomId, { roomId, action, roomPk: state });
    } catch {
      /* clients converge via GET /rooms/:id/pk polling */
    }
  }
}
