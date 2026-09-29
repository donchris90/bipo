import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../notifications/push.service';

const SWEEP_MS = 60 * 60 * 1000; // same cadence as SeasonAutoSettleService

// The push-notification twin of SeasonAutoSettleService: without this, a season that starts
// just sits there until someone happens to open the app and see the countdown hit zero.
// startNotifiedAt is this sweep's settledAt — a once-only guard so a season is announced
// exactly once no matter how many times the sweep runs or how many instances race.
//
// This is a platform-wide broadcast, not a per-user notification (see PushService.broadcastToAll)
// — there is no single recipient to notifyOnce(), and creating an in-app Notification row for
// every user on every season start would be a very different (and much larger) cost than a push.
@Injectable()
export class SeasonAutoStartService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SeasonAutoStartService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return; // no background timers under test
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // Exposed for tests. Never throws: a failed sweep is retried next hour, and one season
  // failing to announce never blocks the others.
  async sweep(now: Date = new Date()): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const due = await this.prisma.season.findMany({
        where: { startsAt: { lte: now }, startNotifiedAt: null },
        select: { id: true, name: true },
      });

      const notified: string[] = [];
      for (const season of due) {
        try {
          await this.push.broadcastToAll({
            title: 'A new season has started',
            body: `${season.name} is live — jump in and start climbing the leaderboard!`,
            data: { type: 'SEASON_STARTED', seasonId: season.id },
          });
          // Marked done regardless of how many devices the broadcast actually reached — like
          // settleSeason's settledAt, this guards against re-announcing, not against imperfect
          // delivery. A season with poor delivery isn't retried by this sweep; it already
          // happened.
          await this.prisma.season.update({ where: { id: season.id }, data: { startNotifiedAt: now } });
          notified.push(season.id);
          this.logger.log(`Announced season "${season.name}" (${season.id})`);
        } catch (e: any) {
          this.logger.warn(`Could not announce season ${season.id}: ${e?.message ?? e}`);
        }
      }
      return notified;
    } catch (e: any) {
      this.logger.warn(`Season auto-start sweep failed: ${e?.message ?? e}`);
      return [];
    } finally {
      this.sweeping = false;
    }
  }
}
