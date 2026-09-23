import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PkService } from './pk.service';

const SWEEP_MS = 1_000;

/**
 * PostgreSQL-backed safety net for PK timers.
 *
 * BullMQ is the fast path. The database timestamps remain authoritative so a
 * full/unavailable Redis instance cannot strand a PK in COUNTDOWN or ACTIVE.
 */
@Injectable()
export class PkReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PkReaperService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly pk: PkService) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private ticks = 0;

  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      this.ticks++;

      // Unanswered invitations lapse after CHALLENGE_TTL_MS.
      try { await this.pk.expireStaleChallenges(now); }
      catch (e: any) { this.logger.warn(`Could not expire PK invitations: ${e?.message ?? e}`); }

      // Every 5s: a PK whose host is no longer live is ended (the host who
      // left forfeits), instead of running on with one empty side.
      if (this.ticks % 5 === 0) {
        try { await this.pk.endBattlesWithoutHosts(); }
        catch (e: any) { this.logger.warn(`Could not end orphaned PKs: ${e?.message ?? e}`); }
      }

      const countdown = await this.prisma.pKBattle.findMany({
        where: { status: 'COUNTDOWN', startedAt: { lte: now } },
        select: { id: true },
        take: 100,
      });
      for (const battle of countdown) {
        try { await this.pk.activateIfDue(battle.id); }
        catch (e: any) { this.logger.warn(`Could not activate PK ${battle.id}: ${e?.message ?? e}`); }
      }

      const active = await this.prisma.pKBattle.findMany({
        where: { status: 'ACTIVE', endsAt: { lte: now } },
        select: { id: true },
        take: 100,
      });
      for (const battle of active) {
        try { await this.pk.settleIfDue(battle.id); }
        catch (e: any) { this.logger.warn(`Could not settle PK ${battle.id}: ${e?.message ?? e}`); }
      }
    } catch (e: any) {
      this.logger.warn(`PK sweep failed: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
