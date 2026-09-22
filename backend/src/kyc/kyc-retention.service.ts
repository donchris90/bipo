import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Identity photos are deleted this long after a decision (approved or rejected).
// Nothing needs them once a person has been checked, and holding fewer photos
// means less to lose. The submission record (name, ID type, last 4, outcome)
// stays as the audit trail; only the images go.
export const KYC_PHOTO_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 60 * 1000; // hourly

@Injectable()
export class KycRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KycRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return;
    void this.purge(); // catch up right after a deploy or restart
    this.timer = setInterval(() => void this.purge(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // A pending submission is never purged — its photos are still needed.
  async purge(now = Date.now()): Promise<number> {
    try {
      const cutoff = new Date(now - KYC_PHOTO_RETENTION_DAYS * DAY_MS);
      const { count } = await this.prisma.kycDocument.deleteMany({
        where: { submission: { status: { in: ['APPROVED', 'REJECTED'] }, reviewedAt: { lt: cutoff } } },
      });
      if (count > 0) this.logger.log(`Deleted ${count} identity photo(s) older than ${KYC_PHOTO_RETENTION_DAYS} days after review`);
      return count;
    } catch (e: any) {
      this.logger.warn(`Identity photo cleanup failed: ${e?.message ?? e}`);
      return 0;
    }
  }
}
