import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { decideAbandoned } from '../live/live-reaper';
import { RoomsService } from './rooms.service';

const SWEEP_MS = 30_000;
const GRACE_MS = 90_000;

// Closes party rooms whose host has vanished, the same way LiveReaperService
// ends abandoned live streams. Without it, a host who leaves the room screen by
// any route other than "Close room" (app killed, phone died) leaves an OPEN
// room on everyone's Party list forever. Presence is "the host's socket is in
// this room's socket room"; single backend process only (see LiveReaperService).
//
// It also frees seats held by guests whose app has gone away. A guest who is
// minimized keeps their socket in the room (the mobile party session owns it),
// so only a guest who is really gone loses the seat.
@Injectable()
export class RoomReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomReaperService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly absentSince = new Map<string, number>();
  // `${roomId}|${userId}` -> first time the seated guest was seen missing.
  private readonly seatAbsentSince = new Map<string, number>();
  private sweeping = false;
  private sweepingSeats = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly rooms: RoomsService,
  ) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return;
    this.timer = setInterval(() => {
      void this.sweep();
      void this.sweepSeats();
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = Date.now(), graceMs = GRACE_MS): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const open = await this.prisma.partyRoom.findMany({ where: { status: 'OPEN' }, select: { id: true, hostId: true }, take: 500 });
      const present = new Set<string>();
      await Promise.all(open.map(async (r) => { if (await this.realtime.isUserInRoom(r.hostId, `ROOM:${r.id}`)) present.add(r.id); }));
      const abandoned = decideAbandoned({ sessionIds: open.map((r) => r.id), present, absentSince: this.absentSince, now, graceMs });
      const closed: string[] = [];
      for (const id of abandoned) {
        try {
          await this.rooms.closeAbandoned(id);
          this.absentSince.delete(id);
          closed.push(id);
          this.logger.log(`Closed abandoned party room ${id}`);
        } catch (e: any) {
          this.logger.warn(`Could not close abandoned room ${id}: ${e?.message ?? e}`);
        }
      }
      return closed;
    } catch (e: any) {
      this.logger.warn(`Room sweep failed: ${e?.message ?? e}`);
      return [];
    } finally {
      this.sweeping = false;
    }
  }

  // Returns the `${roomId}|${userId}` keys whose seats were released.
  async sweepSeats(now = Date.now(), graceMs = GRACE_MS): Promise<string[]> {
    if (this.sweepingSeats) return [];
    this.sweepingSeats = true;
    try {
      const open = await this.prisma.partyRoom.findMany({ where: { status: 'OPEN' }, select: { id: true, hostId: true }, take: 500 });
      if (!open.length) {
        this.seatAbsentSince.clear();
        return [];
      }
      const hostByRoom = new Map(open.map((r) => [r.id, r.hostId]));
      const seats = await this.prisma.roomSeat.findMany({
        where: { roomId: { in: open.map((r) => r.id) } },
        select: { roomId: true, userId: true },
      });

      const presentByRoom = new Map<string, Set<string>>();
      await Promise.all(open.map(async (r) => {
        presentByRoom.set(r.id, await this.realtime.userIdsInRoom(`ROOM:${r.id}`));
      }));

      const seen = new Set<string>();
      const released: string[] = [];
      for (const seat of seats) {
        if (seat.userId === hostByRoom.get(seat.roomId)) continue; // the host is the other sweep's job
        const key = `${seat.roomId}|${seat.userId}`;
        seen.add(key);
        if (presentByRoom.get(seat.roomId)?.has(seat.userId)) {
          this.seatAbsentSince.delete(key);
          continue;
        }
        const since = this.seatAbsentSince.get(key);
        if (since === undefined) {
          this.seatAbsentSince.set(key, now);
          continue;
        }
        if (now - since < graceMs) continue;
        try {
          await this.rooms.releaseSeat(seat.roomId, seat.userId);
          this.seatAbsentSince.delete(key);
          released.push(key);
          this.logger.log(`Released seat of absent guest ${seat.userId} in room ${seat.roomId}`);
        } catch (e: any) {
          this.logger.warn(`Could not release seat ${key}: ${e?.message ?? e}`);
        }
      }
      // Forget guests who left their seat normally.
      for (const key of [...this.seatAbsentSince.keys()]) if (!seen.has(key)) this.seatAbsentSince.delete(key);
      return released;
    } catch (e: any) {
      this.logger.warn(`Seat sweep failed: ${e?.message ?? e}`);
      return [];
    } finally {
      this.sweepingSeats = false;
    }
  }
}
