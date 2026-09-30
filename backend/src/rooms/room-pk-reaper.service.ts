import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RoomPkService } from './room-pk.service';

const SWEEP_MS = 1_000;

// Database-clock safety net for Room PK, the same idea as PkReaperService: endsAt in PostgreSQL
// is authoritative, so a PK is always settled (or cancelled if its room closed) even if a client
// never asks. Single backend process only, like the other reapers.
@Injectable()
export class RoomPkReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomPkReaperService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly roomPk: RoomPkService) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.roomPk.sweep();
    } catch (e: any) {
      this.logger.warn(`Room PK sweep failed: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
