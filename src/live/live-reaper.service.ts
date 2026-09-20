import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LiveService } from './live.service';
import { decideAbandoned } from './live-reaper';

const SWEEP_MS = 30_000;
const GRACE_MS = 90_000;

// Ends broadcasts whose host has vanished. Without this, a host whose app is
// killed (or whose phone dies) leaves a LIVE row behind: it shows on everyone's
// Home forever, and the host can't start a new stream because the backend
// refuses a second active session.
//
// Presence is "is the host's socket in this session's room". It is measured
// on this server process only (there is no shared socket adapter), so with
// several backend instances each one would only see its own sockets — add the
// Redis adapter before scaling out. After a restart the first sweep just starts
// the clock, so hosts get a full grace period to reconnect.
@Injectable()
export class LiveReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveReaperService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly absentSince = new Map<string, number>();
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly live: LiveService,
  ) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return; // no background timers under test
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // Exposed for tests. Never throws: a failed sweep is retried on the next tick.
  async sweep(now = Date.now(), graceMs = GRACE_MS): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const sessions = await this.prisma.liveSession.findMany({
        where: { status: 'LIVE' },
        select: { id: true, hostId: true },
        take: 500,
      });

      const present = new Set<string>();
      await Promise.all(
        sessions.map(async (s) => {
          if (await this.realtime.isUserInRoom(s.hostId, `LIVE:${s.id}`)) present.add(s.id);
        }),
      );

      const abandoned = decideAbandoned({
        sessionIds: sessions.map((s) => s.id),
        present,
        absentSince: this.absentSince,
        now,
        graceMs,
      });

      const ended: string[] = [];
      for (const id of abandoned) {
        try {
          await this.live.endAbandoned(id);
          this.absentSince.delete(id);
          ended.push(id);
          this.logger.log(`Ended abandoned live session ${id}`);
        } catch (e: any) {
          this.logger.warn(`Could not end abandoned session ${id}: ${e?.message ?? e}`);
        }
      }
      return ended;
    } catch (e: any) {
      this.logger.warn(`Live sweep failed: ${e?.message ?? e}`);
      return [];
    } finally {
      this.sweeping = false;
    }
  }
}
