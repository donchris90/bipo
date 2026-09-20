import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Queue } from 'bullmq';
import { PK_QUEUE } from '../queue/queue.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotBlocked } from '../common/blocks';

const COUNTDOWN_MS = 10_000;
const DEFAULT_BATTLE_DURATION_MS = 3 * 60_000;

@Injectable()
export class PkService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PK_QUEUE) private readonly pkQueue: Queue,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  async challenge(challengerId: string, opponentId: string) {
    if (challengerId === opponentId) throw new BadRequestException('Cannot challenge yourself');
    await assertNotBlocked(this.prisma, challengerId, opponentId, "You can't challenge this user");
    const battle = await this.prisma.pKBattle.create({
      data: { challengerId, opponentId, status: 'CHALLENGED' },
    });

    // A challenged user otherwise only finds out by polling the incoming
    // list. The name is snapshotted into the payload so the inbox needs no
    // follow-up lookup.
    const challenger = await this.prisma.user.findUnique({
      where: { id: challengerId },
      select: { displayName: true },
    });
    await this.notifications.notify(opponentId, 'PK_CHALLENGE', {
      battleId: battle.id,
      challengerId,
      challengerDisplayName: challenger?.displayName ?? null,
    });

    return battle;
  }

  // Without this, a challenged user has no way to ever discover the
  // challenge exists — challenge() doesn't fire a notification, and
  // there was no list endpoint at all. accept() requires already knowing
  // the battle id, which nothing gave the opponent. Ordered most-recent
  // first since a user is very unlikely to have more than a handful of
  // pending challenges at once.
  incomingChallenges(userId: string) {
    return this.prisma.pKBattle.findMany({
      where: { opponentId: userId, status: 'CHALLENGED' },
      orderBy: { createdAt: 'desc' },
    });
  }

  // The missing link this whole feature needed — PKBattle only ever
  // connected two userIds, with no relation to LiveSession at all, so
  // there was previously no way for a viewer watching one host to learn
  // "they're in a PK battle right now, and here's the opponent's live
  // channel to join too." This derives that answer from data that
  // already exists rather than adding a redundant, staleness-prone FK:
  // a battle is truly "live" the moment its status is ACTIVE, and the
  // opponent's current session is whatever LiveSession row currently has
  // status LIVE for their id — both already real, both already correct
  // the instant either changes, with nothing here to keep in sync by hand.
  async findActiveForHost(hostId: string) {
    const battle = await this.prisma.pKBattle.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [{ challengerId: hostId }, { opponentId: hostId }],
      },
      orderBy: { startedAt: 'desc' },
    });
    if (!battle) return null;

    const opponentId = battle.challengerId === hostId ? battle.opponentId : battle.challengerId;
    const [opponentSession, opponent] = await Promise.all([
      this.prisma.liveSession.findFirst({
        where: { hostId: opponentId, status: 'LIVE' },
        select: { id: true, providerChannel: true, title: true },
      }),
      this.prisma.user.findUnique({ where: { id: opponentId }, select: { displayName: true } }),
    ]);

    return {
      battle,
      opponentId,
      opponentDisplayName: opponent?.displayName ?? null,
      // null here is a real, meaningful state — the battle is active but
      // the opponent isn't currently broadcasting (they may have
      // disconnected, or the accept happened before either went live).
      // The mobile client should show the clash bar with only the local
      // host's video in that case, not fail outright.
      opponentSession,
    };
  }

  async accept(battleId: string, opponentId: string) {
    const battle = await this.prisma.pKBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.opponentId !== opponentId) throw new ForbiddenException('Only the challenged creator can accept');
    if (battle.status !== 'CHALLENGED') throw new BadRequestException('Battle is not awaiting acceptance');

    const now = new Date();
    const startedAt = new Date(now.getTime() + COUNTDOWN_MS);
    const endsAt = new Date(now.getTime() + COUNTDOWN_MS + DEFAULT_BATTLE_DURATION_MS);

    const updated = await this.prisma.pKBattle.update({
      where: { id: battleId },
      data: { status: 'COUNTDOWN', startedAt, endsAt },
    });

    // If scheduling either job fails (Redis unavailable, this class of
    // BullMQ validation error, etc.), roll the battle back to CHALLENGED
    // rather than leaving it stranded in COUNTDOWN with nothing that will
    // ever move it forward. The opponent can then just accept again. This
    // replaces an earlier version of this comment that claimed the battle
    // "fails loudly rather than silently leaving a battle stuck" — that
    // was aspirational, not actually implemented, and a real bug (BullMQ
    // job IDs can't contain `:`) proved it wrong the first time this ran
    // against live infrastructure.
    try {
      await this.pkQueue.add(
        'activate',
        { battleId },
        { delay: Math.max(startedAt.getTime() - now.getTime(), 0), jobId: `activate-${battleId}` },
      );
      await this.pkQueue.add(
        'settle',
        { battleId },
        { delay: Math.max(endsAt.getTime() - now.getTime(), 0), jobId: `settle-${battleId}` },
      );
    } catch (e) {
      await this.prisma.pKBattle.update({
        where: { id: battleId },
        data: { status: 'CHALLENGED', startedAt: null, endsAt: null },
      });
      throw e;
    }

    // Only announced once both jobs are safely scheduled — the rollback
    // above means a failed accept never tells anyone a countdown started.
    await this.emitLifecycle('pk:countdown_start', updated);

    return updated;
  }

  // Transitions COUNTDOWN -> ACTIVE once startedAt has passed. In production
  // this is a scheduled job (BullMQ delayed job keyed off startedAt); here
  // it's exposed as an idempotent call so it can be polled or triggered
  // manually until a job queue is wired in.
  async activateIfDue(battleId: string) {
    const battle = await this.prisma.pKBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.status !== 'COUNTDOWN' || !battle.startedAt || battle.startedAt > new Date()) return battle;

    // Guarded transition: if the scheduled job and a manual POST race, only
    // the call that actually flips COUNTDOWN -> ACTIVE announces it.
    const flipped = await this.prisma.pKBattle.updateMany({
      where: { id: battleId, status: 'COUNTDOWN' },
      data: { status: 'ACTIVE' },
    });
    const current = await this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battleId } });
    if (flipped.count === 1) await this.emitLifecycle('pk:active', current);
    return current;
  }

  // Server-authoritative settlement — the client never determines or
  // displays a winner as final (spec §16). Same "not yet a scheduled job"
  // caveat as activateIfDue.
  async settleIfDue(battleId: string) {
    // The winner is computed from the scores read here, so the write is
    // conditional on those scores (and ACTIVE status) being unchanged. If a
    // gift lands in between, the guard misses, we re-read, and settle on the
    // fresh scores instead of crowning a winner from stale ones. If another
    // caller settled first, the re-read sees SETTLED and returns without
    // announcing a second time.
    for (let attempt = 0; attempt < 3; attempt++) {
      const battle = await this.prisma.pKBattle.findUnique({ where: { id: battleId } });
      if (!battle) throw new NotFoundException('Battle not found');
      if (battle.status !== 'ACTIVE') return battle;
      if (!battle.endsAt || battle.endsAt > new Date()) return battle; // not over yet

      const winnerId =
        battle.scoreChallenger === battle.scoreOpponent
          ? null // tie — product decision on tie-breaking (sudden death, split reward, etc.) not made here
          : battle.scoreChallenger > battle.scoreOpponent
            ? battle.challengerId
            : battle.opponentId;

      const settledNow = await this.prisma.pKBattle.updateMany({
        where: {
          id: battleId,
          status: 'ACTIVE',
          scoreChallenger: battle.scoreChallenger,
          scoreOpponent: battle.scoreOpponent,
        },
        data: { status: 'SETTLED', settledAt: new Date(), winnerId },
      });

      if (settledNow.count === 1) {
        const settled = await this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battleId } });
        await this.emitLifecycle('pk:settled', settled);
        await this.notifyResult(settled);
        return settled;
      }
    }
    return this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battleId } });
  }

  // One notification per participant, once per battle (the dedupe key also
  // covers a settle job racing a manual POST).
  private async notifyResult(battle: {
    id: string;
    challengerId: string;
    opponentId: string;
    scoreChallenger: bigint;
    scoreOpponent: bigint;
    winnerId: string | null;
  }) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [battle.challengerId, battle.opponentId] } },
      select: { id: true, displayName: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));

    const forSide = (userId: string, opponentId: string, mine: bigint, theirs: bigint) =>
      this.notifications.notifyOnce(userId, 'PK_RESULT', `pk_result:${battle.id}`, {
        battleId: battle.id,
        result: battle.winnerId == null ? 'DRAW' : battle.winnerId === userId ? 'WIN' : 'LOSS',
        myScore: mine.toString(),
        opponentScore: theirs.toString(),
        opponentId,
        opponentDisplayName: nameById.get(opponentId) ?? null,
      });

    await Promise.all([
      forSide(battle.challengerId, battle.opponentId, battle.scoreChallenger, battle.scoreOpponent),
      forSide(battle.opponentId, battle.challengerId, battle.scoreOpponent, battle.scoreChallenger),
    ]);
  }

  // ── History ─────────────────────────────────────────────────────

  async history(userId: string, limit?: number, before?: string) {
    const take = Math.min(Math.max(Math.floor(limit ?? 20) || 20, 1), 50);

    let beforeDate: Date | undefined;
    if (before) {
      beforeDate = new Date(before);
      if (Number.isNaN(beforeDate.getTime())) throw new BadRequestException('before must be an ISO timestamp');
    }

    const mine = { OR: [{ challengerId: userId }, { opponentId: userId }] };

    const rows = await this.prisma.pKBattle.findMany({
      where: { status: 'SETTLED', ...mine, ...(beforeDate ? { settledAt: { lt: beforeDate } } : {}) },
      orderBy: { settledAt: 'desc' },
      take,
    });

    const opponentIds = [...new Set(rows.map((b) => (b.challengerId === userId ? b.opponentId : b.challengerId)))];
    const users = opponentIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: opponentIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));

    const [wins, losses, draws] = await Promise.all([
      this.prisma.pKBattle.count({ where: { status: 'SETTLED', ...mine, winnerId: userId } }),
      this.prisma.pKBattle.count({
        where: { status: 'SETTLED', ...mine, AND: [{ winnerId: { not: null } }, { winnerId: { not: userId } }] },
      }),
      this.prisma.pKBattle.count({ where: { status: 'SETTLED', ...mine, winnerId: null } }),
    ]);

    return {
      record: { wins, losses, draws },
      battles: rows.map((b) => {
        const isChallenger = b.challengerId === userId;
        const opponentId = isChallenger ? b.opponentId : b.challengerId;
        return {
          id: b.id,
          opponentId,
          opponentDisplayName: nameById.get(opponentId) ?? null,
          myScore: (isChallenger ? b.scoreChallenger : b.scoreOpponent).toString(),
          opponentScore: (isChallenger ? b.scoreOpponent : b.scoreChallenger).toString(),
          result: b.winnerId == null ? ('DRAW' as const) : b.winnerId === userId ? ('WIN' as const) : ('LOSS' as const),
          startedAt: b.startedAt,
          settledAt: b.settledAt,
        };
      }),
    };
  }

  // ── Realtime lifecycle push ────────────────────────────────────

  // Best-effort: the DB row is the source of truth (and mobile keeps a slow
  // poll as a fallback), so a failure to push must never fail the
  // transition that triggered it.
  private async emitLifecycle(
    event: 'pk:countdown_start' | 'pk:active' | 'pk:settled',
    battle: {
      id: string;
      challengerId: string;
      opponentId: string;
      status: string;
      scoreChallenger: bigint;
      scoreOpponent: bigint;
      startedAt: Date | null;
      endsAt: Date | null;
      winnerId: string | null;
      settledAt: Date | null;
    },
  ) {
    try {
      const sessions = await this.prisma.liveSession.findMany({
        where: { hostId: { in: [battle.challengerId, battle.opponentId] }, status: 'LIVE' },
        select: { id: true },
      });

      this.realtime.broadcastPkEvent(
        battle.id,
        [battle.challengerId, battle.opponentId],
        sessions.map((s) => s.id),
        event,
        {
          pkBattleId: battle.id,
          challengerId: battle.challengerId,
          opponentId: battle.opponentId,
          status: battle.status,
          scoreChallenger: battle.scoreChallenger.toString(),
          scoreOpponent: battle.scoreOpponent.toString(),
          startedAt: battle.startedAt,
          endsAt: battle.endsAt,
          winnerId: battle.winnerId,
          settledAt: battle.settledAt,
          // Lets clients correct for device clock skew when drawing the
          // countdown from startedAt/endsAt.
          serverTime: new Date().toISOString(),
        },
      );
    } catch {
      /* clients converge via the fallback poll */
    }
  }

  get(battleId: string) {
    return this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battleId } });
  }
}
