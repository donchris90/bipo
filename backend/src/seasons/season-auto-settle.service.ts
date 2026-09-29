import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SeasonsService } from './seasons.service';

const SWEEP_MS = 60 * 60 * 1000; // hourly — same cadence as KycRetentionService
const AUTO_SETTLE_ACTOR_ID = 'system:season-auto-settle';

// Without this, a season that ends just sits unpaid until an admin remembers to click
// Settle (see the "Deliberately deferred" note this closes, in SeasonsService's header).
// This finds every season whose window has closed but hasn't been settled, and settles it
// through the exact same SeasonsService.settleSeason path an admin's click would take —
// same payout transaction, same once-only guarantee (settledAt), same winner
// notifications. Nothing about settlement itself changes here, only who triggers it and
// when. actorId is a fixed sentinel string, not a real user — AuditLog.actorId has no FK,
// so this shows up in the audit trail as a distinct, greppable actor rather than as
// whichever admin happened to be logged in when the sweep ran.
@Injectable()
export class SeasonAutoSettleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SeasonAutoSettleService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly seasons: SeasonsService,
  ) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return; // no background timers under test
    void this.sweep(); // catch up right after a deploy or restart
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // Exposed for tests. Never throws: a failed sweep is retried next hour, and one season
  // failing to settle (e.g. a bad reward-tier row) never blocks the others from settling.
  async sweep(now: Date = new Date()): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const due = await this.prisma.season.findMany({
        where: { endsAt: { lt: now }, settledAt: null },
        select: { id: true, name: true },
      });

      const settled: string[] = [];
      for (const season of due) {
        try {
          await this.seasons.settleSeason(season.id, AUTO_SETTLE_ACTOR_ID, []);
          settled.push(season.id);
          this.logger.log(`Auto-settled season "${season.name}" (${season.id})`);
        } catch (e: any) {
          this.logger.warn(`Could not auto-settle season ${season.id}: ${e?.message ?? e}`);
        }
      }
      return settled;
    } catch (e: any) {
      this.logger.warn(`Season auto-settle sweep failed: ${e?.message ?? e}`);
      return [];
    } finally {
      this.sweeping = false;
    }
  }
}
