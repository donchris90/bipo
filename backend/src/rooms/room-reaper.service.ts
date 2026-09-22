import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { decideAbandoned } from '../live/live-reaper';
import { RoomsService } from './rooms.service';

const SWEEP_MS = 30_000;
const GRACE_MS = 90_000;

// Closes party rooms whose host has vanished, the same way LiveReaperService
// ends abandoned live streams. Without it, a host who leaves the room screen by
// any route other than "Close room" (back button, gesture, app killed) leaves an
// OPEN room on everyone's Party list forever. Presence is "the host's socket is in
// this room's socket room"; single backend process only (see LiveReaperService).
@Injectable()
export class RoomReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomReaperService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly absentSince = new Map<string, number>();
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly rooms: RoomsService,
  ) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
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
}
