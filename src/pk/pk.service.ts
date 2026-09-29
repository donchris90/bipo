import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Queue } from 'bullmq';
import { PK_QUEUE } from '../queue/queue.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotBlocked } from '../common/blocks';
import { loadPkSupporters } from '../economy/pk-score';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { randomInt } from 'node:crypto';
import { createMoment } from '../experience/experience.moments';
import { SeasonsService } from '../seasons/seasons.service';

const COUNTDOWN_MS = 10_000;
// Battle lengths a host may pick, in seconds. One list, used by the server to validate and
// mirrored by the app's picker (api/pk.ts). 180 stays the default: it is what every PK was before.
export const PK_DURATIONS_SEC = [180, 300, 600, 900] as const;
export const DEFAULT_PK_DURATION_SEC = 180;

function normalizeDuration(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_PK_DURATION_SEC;
  const n = Number(value);
  if (!(PK_DURATIONS_SEC as readonly number[]).includes(n)) {
    throw new BadRequestException(`PK length must be one of: ${PK_DURATIONS_SEC.map((x) => `${x / 60} min`).join(', ')}`);
  }
  return n;
}
// An unanswered PK invitation lapses after this long (BIGO/Poppo style), so
// a challenger is never stuck waiting and old invites don't pile up.
export const CHALLENGE_TTL_MS = 30_000;
// After the buzzer both hosts stay side by side with the WIN/LOSE result
// (the "punishment" window) before going back to solo.
export const RESULT_MS = 30_000;

export type PkPhase = 'COUNTDOWN' | 'ACTIVE' | 'RESULT';
export type PkCloseReason = 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';

const isExpired = (createdAt: Date, now = Date.now()) => now - createdAt.getTime() >= CHALLENGE_TTL_MS;

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

@Injectable()
export class PkService implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PK_QUEUE) private readonly pkQueue: Queue,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly seasons?: SeasonsService,
  ) {
    this.redis = new IORedis(this.config?.get<string>('REDIS_URL') ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.redis.on('error', () => undefined);
  }

  private readonly redis: IORedis;

  async onModuleDestroy() { await this.redis.quit().catch(() => undefined); }

  private buildObjectives() {
    const pool = [
      { key: 'COIN_TARGET', label: 'Reach 5,000 PK points', target: 5000 },
      { key: 'GIFT_COUNT', label: 'Receive 5 gifts during PK', target: 5 },
      { key: 'COIN_TARGET', label: 'Reach 10,000 PK points', target: 10000 },
    ];
    return [pool[Math.floor(Math.random() * pool.length)]];
  }

  async challenge(challengerId: string, opponentId: string, durationSecInput?: number) {
    const durationSec = normalizeDuration(durationSecInput);
    if (challengerId === opponentId) throw new BadRequestException('Cannot challenge yourself');
    await assertNotBlocked(this.prisma, challengerId, opponentId, "You can't challenge this user");

    // A PK opponent must be actively broadcasting, not merely online in the app.
    // A normal online presence is not enough to create the second live video tile.
    const opponentLive = await this.prisma.liveSession.findFirst({
      where: { hostId: opponentId, status: 'LIVE' },
      select: { id: true },
    });
    if (!opponentLive) throw new BadRequestException("They aren't live right now");
    const challengerLive = await this.prisma.liveSession.findFirst({
      where: { hostId: challengerId, status: 'LIVE' },
      select: { id: true },
    });
    if (!challengerLive) throw new BadRequestException('You must be live before starting a PK');
    const busy = await this.prisma.pKBattle.findFirst({
      where: { status: { in: ['ACCEPTED', 'COUNTDOWN', 'ACTIVE'] }, OR: [{ challengerId: opponentId }, { opponentId }] },
      select: { id: true },
    });
    if (busy) throw new BadRequestException('They are in a PK battle right now');
    const selfBusy = await this.prisma.pKBattle.findFirst({
      where: { status: { in: ['ACCEPTED', 'COUNTDOWN', 'ACTIVE'] }, OR: [{ challengerId }, { opponentId: challengerId }] },
      select: { id: true },
    });
    if (selfBusy) throw new BadRequestException('Finish your current PK first');
    // Tapping Challenge twice must not send two challenges.
    const pending = await this.prisma.pKBattle.findFirst({ where: { challengerId, opponentId, status: 'CHALLENGED' } });
    if (pending && !isExpired(pending.createdAt) && pending.durationSec === durationSec) return pending;
    // One invitation at a time: a new challenge replaces any other one this
    // host still has waiting (including an expired one to the same person).
    await this.closeChallenges({ challengerId, status: 'CHALLENGED' }, 'SUPERSEDED');

    const battle = await this.prisma.pKBattle.create({
      data: { challengerId, opponentId, status: 'CHALLENGED', durationSec, objectiveConfig: this.buildObjectives() },
    });

    // A challenged user otherwise only finds out by polling the incoming
    // list. The name is snapshotted into the payload so the inbox needs no
    // follow-up lookup.
    const challenger = await this.prisma.user.findUnique({
      where: { id: challengerId },
      select: { displayName: true, avatarUrl: true },
    });
    await this.notifications.notify(opponentId, 'PK_CHALLENGE', {
      battleId: battle.id,
      challengerId,
      challengerDisplayName: challenger?.displayName ?? null,
    });
    // Instantly, to wherever they are in the app, so the challenge can appear on
    // their screen as a banner (the inbox item above is the record of it).
    this.realtime.emitToUser(opponentId, 'pk:challenge', {
      battleId: battle.id,
      challengerId,
      challengerDisplayName: challenger?.displayName ?? null,
      challengerAvatarUrl: challenger?.avatarUrl ?? null,
    });

    return battle;
  }

  // ── Random PK matchmaking ────────────────────────────────────────
  // Unlike the old /random shortcut, this is a real opt-in queue. Two live hosts
  // are paired without either side manually selecting the other; the match enters
  // the same COUNTDOWN -> ACTIVE -> SETTLED lifecycle as normal PK.
  private randomQueueKey = 'pk:random:queue';
  private randomLockKey = 'pk:random:lock';
  private randomTicketPrefix = 'pk:random:ticket:';
  private randomTicketTtl = 90;

  private async isHostLive(userId: string) {
    return !!(await this.prisma.liveSession.findFirst({ where: { hostId: userId, status: 'LIVE' }, select: { id: true } }));
  }

  private async isPkBusy(userId: string) {
    return !!(await this.prisma.pKBattle.findFirst({
      where: { status: { in: ['CHALLENGED', 'ACCEPTED', 'COUNTDOWN', 'ACTIVE'] }, OR: [{ challengerId: userId }, { opponentId: userId }] },
      select: { id: true },
    }));
  }

  private async withRandomLock<T>(fn: () => Promise<T>): Promise<T> {
    const token = `${Date.now()}-${Math.random()}`;
    try {
      const locked = await this.redis.set(this.randomLockKey, token, 'PX', 5000, 'NX');
      if (!locked) throw new BadRequestException('Random PK matchmaking is busy. Please try again.');
      return await fn();
    } finally {
      const current = await this.redis.get(this.randomLockKey).catch(() => null);
      if (current === token) await this.redis.del(this.randomLockKey).catch(() => undefined);
    }
  }

  async randomMatch(userId: string, durationSecInput?: number) {
    const durationSec = normalizeDuration(durationSecInput);
    if (!(await this.isHostLive(userId))) throw new BadRequestException('You must be live before joining Random PK');
    if (await this.isPkBusy(userId)) throw new BadRequestException('Finish your current PK first');

    const ticketKey = `${this.randomTicketPrefix}${userId}`;
    const existingRaw = await this.redis.get(ticketKey).catch(() => null);
    if (existingRaw) return JSON.parse(existingRaw);

    return this.withRandomLock(async () => {
      const again = await this.redis.get(ticketKey).catch(() => null);
      if (again) return JSON.parse(again);

      let ids = await this.redis.lrange(this.randomQueueKey, 0, 199).catch(() => [] as string[]);
      const unique = [...new Set(ids)].filter((id) => id !== userId);
      const valid: string[] = [];
      const waitingDuration = new Map<string, number>();
      for (const id of unique) {
        const rawTicket = await this.redis.get(`${this.randomTicketPrefix}${id}`).catch(() => null);
        if (rawTicket && await this.isHostLive(id) && !(await this.isPkBusy(id))) {
          valid.push(id);
          try { waitingDuration.set(id, Number(JSON.parse(rawTicket).durationSec) || DEFAULT_PK_DURATION_SEC); } catch { waitingDuration.set(id, DEFAULT_PK_DURATION_SEC); }
        }
      }
      if (valid.length) {
        // Prefer someone who picked the same length; otherwise take anyone waiting and use THEIR
        // length (they were in the queue first).
        const sameLength = valid.filter((id) => waitingDuration.get(id) === durationSec);
        const pool = sameLength.length ? sameLength : valid;
        const opponentId = pool[randomInt(pool.length)];
        const battleDuration = waitingDuration.get(opponentId) ?? durationSec;
        await this.redis.lrem(this.randomQueueKey, 0, opponentId).catch(() => undefined);
        await this.redis.del(`${this.randomTicketPrefix}${opponentId}`).catch(() => undefined);
        const battle = await this.createRandomBattle(opponentId, userId, battleDuration);
        const opponentTicket = { status: 'MATCHED', battleId: battle.id, opponentId: userId, durationSec: battleDuration };
        const myTicket = { status: 'MATCHED', battleId: battle.id, opponentId, durationSec: battleDuration };
        await this.redis.set(`${this.randomTicketPrefix}${opponentId}`, JSON.stringify(opponentTicket), 'EX', this.randomTicketTtl);
        await this.redis.set(ticketKey, JSON.stringify(myTicket), 'EX', this.randomTicketTtl);
        return myTicket;
      }

      await this.redis.rpush(this.randomQueueKey, userId);
      const ticket = { status: 'WAITING', queuePosition: await this.redis.llen(this.randomQueueKey), durationSec };
      await this.redis.set(ticketKey, JSON.stringify(ticket), 'EX', this.randomTicketTtl);
      return ticket;
    });
  }

  async randomMatchStatus(userId: string) {
    const raw = await this.redis.get(`${this.randomTicketPrefix}${userId}`).catch(() => null);
    if (!raw) return { status: 'NOT_IN_QUEUE' as const };
    const ticket = JSON.parse(raw);
    if (ticket.status === 'WAITING') {
      const position = await this.redis.lpos(this.randomQueueKey, userId).catch(() => null);
      return { ...ticket, queuePosition: position == null ? 1 : position + 1 };
    }
    return ticket;
  }

  async cancelRandomMatch(userId: string) {
    await this.redis.lrem(this.randomQueueKey, 0, userId).catch(() => undefined);
    await this.redis.del(`${this.randomTicketPrefix}${userId}`).catch(() => undefined);
    return { status: 'CANCELLED' as const };
  }

  private async createRandomBattle(challengerId: string, opponentId: string, durationSec: number = DEFAULT_PK_DURATION_SEC) {
    const now = new Date();
    const startedAt = new Date(now.getTime() + COUNTDOWN_MS);
    const endsAt = new Date(now.getTime() + COUNTDOWN_MS + durationSec * 1000);
    const battle = await this.prisma.pKBattle.create({
      data: { challengerId, opponentId, status: 'COUNTDOWN', mode: 'RANDOM', startedAt, endsAt, durationSec, objectiveConfig: this.buildObjectives() },
    });
    void this.scheduleTransitionsBestEffort(battle.id, startedAt, endsAt);
    await this.emitLifecycle('pk:countdown_start', battle);
    this.realtime.emitToUser(challengerId, 'pk:random_match', { battleId: battle.id, opponentId });
    this.realtime.emitToUser(opponentId, 'pk:random_match', { battleId: battle.id, opponentId: challengerId });
    return battle;
  }

  // ── Team PK ─────────────────────────────────────────────────────
  // A Team PK uses the existing two-video battle and authoritative settlement,
  // while associating each side with a Rryda Team. Gifts received by any member
  // of the participating team can contribute to that team's PK score.
  async teamCandidates(userId: string) {
    const membership = await this.prisma.teamMember.findUnique({ where: { userId }, select: { teamId: true, role: true } });
    if (!membership || membership.role !== 'LEADER') throw new BadRequestException('Only a team leader can start a Team PK');
    const teams = await this.prisma.team.findMany({ where: { id: { not: membership.teamId } }, orderBy: { teamXp: 'desc' }, take: 100, select: { id: true, name: true, themeColor: true, leaderId: true, teamLevel: true, teamXp: true } });
    const liveLeaders = await this.prisma.liveSession.findMany({ where: { hostId: { in: teams.map((t) => t.leaderId) }, status: 'LIVE' }, select: { hostId: true } });
    const live = new Set(liveLeaders.map((x) => x.hostId));
    return teams.filter((t) => live.has(t.leaderId)).map((t) => ({ ...t, live: true }));
  }

  async teamChallenge(userId: string, opponentTeamId: string, durationSecInput?: number) {
    const durationSec = normalizeDuration(durationSecInput);
    const mine = await this.prisma.teamMember.findUnique({ where: { userId }, select: { teamId: true, role: true } });
    if (!mine || mine.role !== 'LEADER') throw new BadRequestException('Only a team leader can start a Team PK');
    const opponentTeam = await this.prisma.team.findUnique({ where: { id: opponentTeamId }, select: { id: true, name: true, leaderId: true, themeColor: true } });
    if (!opponentTeam) throw new NotFoundException('Opponent team not found');
    if (opponentTeam.id === mine.teamId) throw new BadRequestException('Cannot challenge your own team');
    await assertNotBlocked(this.prisma, userId, opponentTeam.leaderId, "You can't challenge this team");
    if (!(await this.isHostLive(userId)) || !(await this.isHostLive(opponentTeam.leaderId))) throw new BadRequestException('Both team leaders must be live');
    if (await this.isPkBusy(userId) || await this.isPkBusy(opponentTeam.leaderId)) throw new BadRequestException('One of the team leaders is already in a PK');
    const battle = await this.prisma.pKBattle.create({ data: { challengerId: userId, opponentId: opponentTeam.leaderId, challengerTeamId: mine.teamId, opponentTeamId: opponentTeam.id, mode: 'TEAM', status: 'CHALLENGED', durationSec, objectiveConfig: this.buildObjectives() } });
    const challenger = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, avatarUrl: true } });
    this.realtime.emitToUser(opponentTeam.leaderId, 'pk:challenge', { battleId: battle.id, challengerId: userId, challengerDisplayName: challenger?.displayName ?? null, challengerAvatarUrl: challenger?.avatarUrl ?? null, mode: 'TEAM', teamName: opponentTeam.name });
    await this.notifications.notify(opponentTeam.leaderId, 'PK_CHALLENGE', { battleId: battle.id, challengerId: userId, challengerDisplayName: challenger?.displayName ?? null, mode: 'TEAM', challengerTeamId: mine.teamId, opponentTeamId: opponentTeam.id });
    return battle;
  }

  // ── Family/Guild PK ────────────────────────────────────────────
  // Mirrors Team PK exactly, one level up: the agency OWNER plays the same role a team leader
  // does (the only one who can start or accept the battle on behalf of the whole agency), and
  // every approved member's gifts pool into their agency's side — see
  // GiftService.resolvePkBattleId / applyPkScore, extended the same way the TEAM fallback works.
  async agencyCandidates(userId: string) {
    const owned = await this.prisma.agency.findFirst({ where: { ownerId: userId, status: 'APPROVED' }, select: { id: true } });
    if (!owned) throw new BadRequestException('Only an approved agency owner can start a Family PK');
    const agencies = await this.prisma.agency.findMany({ where: { id: { not: owned.id }, status: 'APPROVED' }, take: 100, select: { id: true, name: true, ownerId: true } });
    const liveOwners = await this.prisma.liveSession.findMany({ where: { hostId: { in: agencies.map((a) => a.ownerId) }, status: 'LIVE' }, select: { hostId: true } });
    const live = new Set(liveOwners.map((x) => x.hostId));
    const memberCounts = await this.prisma.agencyMembership.groupBy({ by: ['agencyId'], where: { agencyId: { in: agencies.map((a) => a.id) }, status: 'ACTIVE' }, _count: { agencyId: true } });
    const countByAgency = new Map(memberCounts.map((m) => [m.agencyId, m._count.agencyId]));
    return agencies
      .filter((a) => live.has(a.ownerId))
      .map((a) => ({ id: a.id, name: a.name, memberCount: countByAgency.get(a.id) ?? 0, live: true }))
      .sort((a, b) => b.memberCount - a.memberCount);
  }

  async agencyChallenge(userId: string, opponentAgencyId: string, durationSecInput?: number) {
    const durationSec = normalizeDuration(durationSecInput);
    const mine = await this.prisma.agency.findFirst({ where: { ownerId: userId, status: 'APPROVED' }, select: { id: true } });
    if (!mine) throw new BadRequestException('Only an approved agency owner can start a Family PK');
    const opponentAgency = await this.prisma.agency.findUnique({ where: { id: opponentAgencyId }, select: { id: true, name: true, ownerId: true, status: true } });
    if (!opponentAgency || opponentAgency.status !== 'APPROVED') throw new NotFoundException('Opponent agency not found');
    if (opponentAgency.id === mine.id) throw new BadRequestException('Cannot challenge your own agency');
    await assertNotBlocked(this.prisma, userId, opponentAgency.ownerId, "You can't challenge this agency");
    if (!(await this.isHostLive(userId)) || !(await this.isHostLive(opponentAgency.ownerId))) throw new BadRequestException('Both agency owners must be live');
    if (await this.isPkBusy(userId) || await this.isPkBusy(opponentAgency.ownerId)) throw new BadRequestException('One of the agency owners is already in a PK');
    const battle = await this.prisma.pKBattle.create({ data: { challengerId: userId, opponentId: opponentAgency.ownerId, challengerAgencyId: mine.id, opponentAgencyId: opponentAgency.id, mode: 'AGENCY', status: 'CHALLENGED', durationSec, objectiveConfig: this.buildObjectives() } });
    const challenger = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, avatarUrl: true } });
    this.realtime.emitToUser(opponentAgency.ownerId, 'pk:challenge', { battleId: battle.id, challengerId: userId, challengerDisplayName: challenger?.displayName ?? null, challengerAvatarUrl: challenger?.avatarUrl ?? null, mode: 'AGENCY', agencyName: opponentAgency.name });
    await this.notifications.notify(opponentAgency.ownerId, 'PK_CHALLENGE', { battleId: battle.id, challengerId: userId, challengerDisplayName: challenger?.displayName ?? null, mode: 'AGENCY', challengerAgencyId: mine.id, opponentAgencyId: opponentAgency.id });
    return battle;
  }

  // ── choosing an opponent ─────────────────────────────────────────

  // Who you can challenge, in one of three groups — always people who are online
  // right now, never yourself, anyone you have blocked (or who blocked you), or
  // anyone already in a battle.
  //   friends — people you follow who follow you back
  //   agency  — the other creators in your agency (and its owner)
  //   random  — creators who are online, in no particular order
  async candidates(userId: string, category: 'friends' | 'agency' | 'random') {
    const online = await this.realtime.onlineUserIds();
    online.delete(userId);

    // PK discovery is based on active broadcasts. A user can be online in the
    // app without having a live room, and such a user cannot be a PK opponent.
    const liveSessions = await this.prisma.liveSession.findMany({
      where: { hostId: { in: [...online] }, status: 'LIVE' },
      select: { hostId: true },
    });
    const liveHostIds = new Set(liveSessions.map((s) => s.hostId));
    let pool: Set<string>;
    if (category === 'friends') {
      const following = await this.prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true }, take: 2000 });
      const followingIds = following.map((f) => f.followingId).filter((id) => liveHostIds.has(id));
      const back = followingIds.length
        ? await this.prisma.follow.findMany({ where: { followerId: { in: followingIds }, followingId: userId }, select: { followerId: true } })
        : [];
      pool = new Set(back.map((f) => f.followerId));
    } else if (category === 'agency') {
      pool = await this.agencyMates(userId);
    } else {
      const creators = await this.prisma.userRole.findMany({ where: { role: 'CREATOR', userId: { in: [...online] } }, select: { userId: true }, take: 2000 });
      pool = new Set(creators.map((c) => c.userId));
    }
    pool = new Set([...pool].filter((id) => id !== userId && liveHostIds.has(id)));
    if (pool.size === 0) return { category, onlineCount: 0, candidates: [] };

    if (pool.size > 0) {
      const [blocks, busy] = await Promise.all([
        this.prisma.block.findMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] }, select: { blockerId: true, blockedId: true } }),
        this.prisma.pKBattle.findMany({ where: { status: { in: ['ACCEPTED', 'COUNTDOWN', 'ACTIVE'] } }, select: { challengerId: true, opponentId: true } }),
      ]);
      for (const b of blocks) {
        pool.delete(b.blockerId);
        pool.delete(b.blockedId);
      }
      for (const b of busy) {
        pool.delete(b.challengerId);
        pool.delete(b.opponentId);
      }
    }

    const ids = [...pool].slice(0, 300);
    const [users, live] = ids.length
      ? await Promise.all([
          this.prisma.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true, displayName: true, avatarUrl: true } }),
          this.prisma.liveSession.findMany({ where: { hostId: { in: ids }, status: 'LIVE' }, select: { id: true, hostId: true, title: true } }),
        ])
      : [[], []];
    const liveByHost = new Map(live.map((l) => [l.hostId, { sessionId: l.id, title: l.title }]));
    let list = users.map((u) => ({ userId: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl, live: liveByHost.get(u.id) ?? null }));

    if (category === 'random') list = shuffle(list).slice(0, 30);
    else list.sort((a, b) => Number(!!b.live) - Number(!!a.live) || (a.displayName ?? '').localeCompare(b.displayName ?? ''));

    return { category, onlineCount: list.length, candidates: list };
  }

  private async agencyMates(userId: string): Promise<Set<string>> {
    const mine = await this.prisma.agencyMembership.findFirst({ where: { creatorId: userId, status: 'ACTIVE' }, select: { agencyId: true } });
    const owned = await this.prisma.agency.findFirst({ where: { ownerId: userId }, select: { id: true } });
    const agencyId = mine?.agencyId ?? owned?.id;
    if (!agencyId) return new Set();
    const [members, agency] = await Promise.all([
      this.prisma.agencyMembership.findMany({ where: { agencyId, status: 'ACTIVE' }, select: { creatorId: true } }),
      this.prisma.agency.findUnique({ where: { id: agencyId }, select: { ownerId: true } }),
    ]);
    const ids = new Set(members.map((m) => m.creatorId));
    if (agency?.ownerId) ids.add(agency.ownerId);
    return ids;
  }

  // "Random match": picks one online creator and challenges them.
  async randomChallenge(userId: string) {
    const { candidates } = await this.candidates(userId, 'random');
    if (candidates.length === 0) throw new NotFoundException('No one is available for a PK right now. Try again in a moment.');
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const battle = await this.challenge(userId, pick.userId);
    return { battle, opponent: { userId: pick.userId, displayName: pick.displayName, avatarUrl: pick.avatarUrl } };
  }

  // The challenged person says no.
  async decline(battleId: string, userId: string) {
    const battle = await this.prisma.pKBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.opponentId !== userId) throw new ForbiddenException('Only the challenged creator can decline');
    if (battle.status !== 'CHALLENGED') throw new BadRequestException('Battle is not awaiting a reply');
    const updated = await this.prisma.pKBattle.update({ where: { id: battleId }, data: { status: 'CANCELLED' } });
    // The challenger used to keep waiting with no idea they'd been turned down.
    this.emitChallengeClosed(battle, 'DECLINED');
    return updated;
  }

  // The challenger withdraws an invitation that hasn't been answered yet.
  async cancel(battleId: string, userId: string) {
    const battle = await this.prisma.pKBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.challengerId !== userId) throw new ForbiddenException('Only the challenger can cancel');
    if (battle.status !== 'CHALLENGED') throw new BadRequestException('This invitation is no longer waiting');
    const flipped = await this.prisma.pKBattle.updateMany({ where: { id: battleId, status: 'CHALLENGED' }, data: { status: 'CANCELLED' } });
    if (flipped.count === 1) this.emitChallengeClosed(battle, 'CANCELLED');
    return this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battleId } });
  }

  // The invitation this host sent that is still waiting, if any — so the
  // host screen can show "Waiting for X… Cancel" with a countdown.
  async outgoing(userId: string) {
    const battle = await this.prisma.pKBattle.findFirst({
      where: { challengerId: userId, status: 'CHALLENGED', createdAt: { gt: new Date(Date.now() - CHALLENGE_TTL_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (!battle) return null;
    const opponent = await this.prisma.user.findUnique({ where: { id: battle.opponentId }, select: { displayName: true, avatarUrl: true } });
    return {
      battle,
      opponentDisplayName: opponent?.displayName ?? null,
      opponentAvatarUrl: opponent?.avatarUrl ?? null,
      expiresAt: new Date(battle.createdAt.getTime() + CHALLENGE_TTL_MS),
      serverTime: new Date(),
    };
  }

  // Without this, a challenged user has no way to ever discover the
  // challenge exists — challenge() doesn't fire a notification, and
  // there was no list endpoint at all. accept() requires already knowing
  // the battle id, which nothing gave the opponent. Ordered most-recent
  // first since a user is very unlikely to have more than a handful of
  // pending challenges at once.
  async incomingChallenges(userId: string) {
    const battles = await this.prisma.pKBattle.findMany({
      where: { opponentId: userId, status: 'CHALLENGED', createdAt: { gt: new Date(Date.now() - CHALLENGE_TTL_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (battles.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: battles.map((b) => b.challengerId) } },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return battles.map((b) => ({
      ...b,
      challengerDisplayName: byId.get(b.challengerId)?.displayName ?? null,
      challengerAvatarUrl: byId.get(b.challengerId)?.avatarUrl ?? null,
      expiresAt: new Date(b.createdAt.getTime() + CHALLENGE_TTL_MS),
    }));
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
  //
  // It now also covers the 10-second COUNTDOWN (both videos already side by
  // side, "PK starts in 3…") and the RESULT window after the buzzer (WIN /
  // LOSE stamps for RESULT_MS), each told apart by `phase`.
  async findActiveForHost(hostId: string, now = new Date()) {
    const battle = await this.prisma.pKBattle.findFirst({
      where: {
        OR: [
          { status: { in: ['COUNTDOWN', 'ACTIVE'] } },
          { status: 'SETTLED', settledAt: { gte: new Date(now.getTime() - RESULT_MS) } },
        ],
        AND: [{ OR: [{ challengerId: hostId }, { opponentId: hostId }] }],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!battle) return null;

    const phase: PkPhase = battle.status === 'COUNTDOWN' ? 'COUNTDOWN' : battle.status === 'ACTIVE' ? 'ACTIVE' : 'RESULT';
    const opponentId = battle.challengerId === hostId ? battle.opponentId : battle.challengerId;
    const [opponentSession, people, supporters] = await Promise.all([
      this.prisma.liveSession.findFirst({
        where: { hostId: opponentId, status: 'LIVE' },
        select: { id: true, providerChannel: true, title: true },
      }),
      this.prisma.user.findMany({ where: { id: { in: [hostId, opponentId] } }, select: { id: true, displayName: true, avatarUrl: true } }),
      loadPkSupporters(this.prisma, battle),
    ]);
    const host = people.find((p) => p.id === hostId);
    const opponent = people.find((p) => p.id === opponentId);

    return {
      battle,
      phase,
      opponentId,
      opponentDisplayName: opponent?.displayName ?? null,
      opponentAvatarUrl: opponent?.avatarUrl ?? null,
      hostDisplayName: host?.displayName ?? null,
      hostAvatarUrl: host?.avatarUrl ?? null,
      // null here is a real, meaningful state — the battle is on but the
      // opponent isn't currently broadcasting. The client shows only the
      // local host's video in that case, not an error.
      opponentSession,
      mode: battle.mode,
      challengerTeamId: battle.challengerTeamId,
      opponentTeamId: battle.opponentTeamId,
      supporters,
      resultEndsAt: phase === 'RESULT' && battle.settledAt ? new Date(battle.settledAt.getTime() + RESULT_MS) : null,
      serverTime: new Date(),
    };
  }

  async accept(battleId: string, opponentId: string) {
    const battle = await this.prisma.pKBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.opponentId !== opponentId) throw new ForbiddenException('Only the challenged creator can accept');
    if (battle.status !== 'CHALLENGED') throw new BadRequestException('Battle is not awaiting acceptance');
    if (isExpired(battle.createdAt)) {
      const flipped = await this.prisma.pKBattle.updateMany({ where: { id: battleId, status: 'CHALLENGED' }, data: { status: 'CANCELLED' } });
      if (flipped.count === 1) this.emitChallengeClosed(battle, 'EXPIRED');
      throw new BadRequestException('This PK invitation has expired');
    }
    const eitherBusy = await this.prisma.pKBattle.findFirst({
      where: {
        status: { in: ['ACCEPTED', 'COUNTDOWN', 'ACTIVE'] },
        OR: [
          { challengerId: { in: [battle.challengerId, battle.opponentId] } },
          { opponentId: { in: [battle.challengerId, battle.opponentId] } },
        ],
      },
      select: { id: true },
    });
    if (eitherBusy) throw new BadRequestException('One of you is already in a PK');

    // Both creators must still be broadcasting when the invitation is accepted.
    // This prevents an accepted PK from entering COUNTDOWN with no second channel.
    const [challengerLive, opponentLive] = await Promise.all([
      this.prisma.liveSession.findFirst({ where: { hostId: battle.challengerId, status: 'LIVE' }, select: { id: true } }),
      this.prisma.liveSession.findFirst({ where: { hostId: battle.opponentId, status: 'LIVE' }, select: { id: true } }),
    ]);
    if (!challengerLive || !opponentLive) {
      throw new BadRequestException('Both creators must be live to start a PK');
    }

    const now = new Date();
    const startedAt = new Date(now.getTime() + COUNTDOWN_MS);
    const endsAt = new Date(now.getTime() + COUNTDOWN_MS + (battle.durationSec ?? DEFAULT_PK_DURATION_SEC) * 1000);

    const flipped = await this.prisma.pKBattle.updateMany({
      where: { id: battleId, status: 'CHALLENGED' },
      data: { status: 'COUNTDOWN', startedAt, endsAt },
    });
    if (flipped.count !== 1) throw new BadRequestException('Battle is not awaiting acceptance');
    const updated = await this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battleId } });

    // Every other invitation to or from either host is now moot.
    const both = [battle.challengerId, battle.opponentId];
    await this.closeChallenges(
      { status: 'CHALLENGED', id: { not: battleId }, OR: [{ challengerId: { in: both } }, { opponentId: { in: both } }] },
      'SUPERSEDED',
    );

    // Redis/BullMQ is a timing fast-path only. Redis can reject writes when
    // its maxmemory limit is reached, so a queue failure must never turn a
    // valid Accept into HTTP 500 or roll the battle back. PkReaperService
    // makes startedAt/endsAt authoritative and recovers the transitions
    // from PostgreSQL when Redis is unavailable.
    void this.scheduleTransitionsBestEffort(battleId, startedAt, endsAt);

    await this.emitLifecycle('pk:countdown_start', updated);

    return updated;
  }

  private async scheduleTransitionsBestEffort(battleId: string, startedAt: Date, endsAt: Date) {
    try {
      await Promise.all([
        this.pkQueue.add(
          'activate',
          { battleId },
          { delay: Math.max(startedAt.getTime() - Date.now(), 0), jobId: `activate-${battleId}` },
        ),
        this.pkQueue.add(
          'settle',
          { battleId },
          { delay: Math.max(endsAt.getTime() - Date.now(), 0), jobId: `settle-${battleId}` },
        ),
      ]);
    } catch (e: any) {
      console.warn(`[PK] transition queue unavailable for ${battleId}: ${e?.message ?? e}`);
    }
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
        const winner = settled.winnerId ?? settled.challengerId;
        if (this.seasons) {
          const participants = [settled.challengerId, settled.opponentId];
          for (const participant of participants) {
            const points = settled.winnerId ? (participant === settled.winnerId ? 25 : 10) : 15;
            void this.seasons.contributePoints(participant, points);
          }
        }
        void createMoment(this.prisma, {
          userId: winner,
          type: 'PK_MOMENT',
          title: settled.winnerId ? 'PK victory moment' : 'PK battle completed',
          description: 'A Rryda PK battle just reached its final result.',
          payload: { battleId: settled.id, mode: settled.mode, scoreChallenger: settled.scoreChallenger.toString(), scoreOpponent: settled.scoreOpponent.toString(), objectives: settled.objectiveConfig ?? [] },
        }).catch(() => undefined);
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

  // ── Ending early ────────────────────────────────────────────────

  // A host leaves the PK before the buzzer (the "End PK" button, or their
  // live ended). During the countdown nothing has happened yet, so the
  // battle is simply called off. Once it is ACTIVE, the other host wins.
  async forfeit(battleId: string, userId: string) {
    const battle = await this.prisma.pKBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new NotFoundException('Battle not found');
    if (battle.challengerId !== userId && battle.opponentId !== userId) {
      throw new ForbiddenException('Only a host in this PK can end it');
    }
    return this.forfeitBy(battle, userId);
  }

  private async forfeitBy(
    battle: { id: string; challengerId: string; opponentId: string; status: string },
    quitterId: string | null,
  ) {
    const now = new Date();
    if (battle.status === 'COUNTDOWN' || battle.status === 'ACCEPTED') {
      const flipped = await this.prisma.pKBattle.updateMany({
        where: { id: battle.id, status: battle.status as any },
        data: { status: 'CANCELLED', settledAt: now },
      });
      const current = await this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battle.id } });
      if (flipped.count === 1) await this.emitLifecycle('pk:settled', current);
      return current;
    }
    if (battle.status === 'ACTIVE') {
      const winnerId = quitterId == null ? null : quitterId === battle.challengerId ? battle.opponentId : battle.challengerId;
      const flipped = await this.prisma.pKBattle.updateMany({
        where: { id: battle.id, status: 'ACTIVE' },
        data: { status: 'SETTLED', settledAt: now, endsAt: now, winnerId },
      });
      const current = await this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battle.id } });
      if (flipped.count === 1) {
        await this.emitLifecycle('pk:settled', current);
        await this.notifyResult(current);
      }
      return current;
    }
    return this.prisma.pKBattle.findUniqueOrThrow({ where: { id: battle.id } });
  }

  // Reaper: invitations nobody answered in time.
  async expireStaleChallenges(now = new Date()) {
    return this.closeChallenges({ status: 'CHALLENGED', createdAt: { lte: new Date(now.getTime() - CHALLENGE_TTL_MS) } }, 'EXPIRED');
  }

  // Reaper: a PK whose host stopped broadcasting (ended the live, app died)
  // can't go on. The host who left forfeits; if both left it's called off.
  async endBattlesWithoutHosts() {
    const running = await this.prisma.pKBattle.findMany({
      where: { status: { in: ['COUNTDOWN', 'ACTIVE'] } },
      select: { id: true, challengerId: true, opponentId: true, status: true },
      take: 200,
    });
    if (running.length === 0) return [];
    const hostIds = [...new Set(running.flatMap((b) => [b.challengerId, b.opponentId]))];
    const live = await this.prisma.liveSession.findMany({
      where: { hostId: { in: hostIds }, status: 'LIVE' },
      select: { hostId: true },
    });
    const liveHosts = new Set(live.map((l) => l.hostId));
    const ended: string[] = [];
    for (const b of running) {
      const challengerLive = liveHosts.has(b.challengerId);
      const opponentLive = liveHosts.has(b.opponentId);
      if (challengerLive && opponentLive) continue;
      const quitter = !challengerLive && !opponentLive ? null : !challengerLive ? b.challengerId : b.opponentId;
      await this.forfeitBy(b, quitter);
      ended.push(b.id);
    }
    return ended;
  }

  // Closes matching CHALLENGED invitations and tells both people involved.
  private async closeChallenges(where: Record<string, unknown>, reason: PkCloseReason) {
    const open = await this.prisma.pKBattle.findMany({
      where: where as any,
      select: { id: true, challengerId: true, opponentId: true },
      take: 200,
    });
    const closed: string[] = [];
    for (const b of open) {
      const flipped = await this.prisma.pKBattle.updateMany({ where: { id: b.id, status: 'CHALLENGED' }, data: { status: 'CANCELLED' } });
      if (flipped.count === 1) {
        this.emitChallengeClosed(b, reason);
        closed.push(b.id);
      }
    }
    return closed;
  }

  private emitChallengeClosed(battle: { id: string; challengerId: string; opponentId: string }, reason: PkCloseReason) {
    const payload = { battleId: battle.id, challengerId: battle.challengerId, opponentId: battle.opponentId, reason };
    try {
      this.realtime.emitToUser(battle.challengerId, 'pk:challenge_closed', payload);
      this.realtime.emitToUser(battle.opponentId, 'pk:challenge_closed', payload);
    } catch {
      /* both screens also poll */
    }
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
