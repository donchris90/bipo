import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LedgerEntryType, WalletType } from '@prisma/client';
import IORedis from 'ioredis';
import { v4 as uuid } from 'uuid';
import { randomInt } from 'node:crypto';
import { randomPlayerName } from './bot-names';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RoundService } from './round.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AyoCaptureMode, AyoState, createInitialAyoState, legalPits, makeMove } from './ayo.rules';
import { calculateSpectatorPoolSplit, calculateWinningSpectatorReward } from './ludo-payout';

type WaitingPlayer = { userId: string; displayName: string; entryFee: number; ticket: string; partyRoomId?: string; matchId?: string; roomCode?: string };
type AyoRoom = { matchId: string; roomCode: string; entryFee: number; players: WaitingPlayer[]; createdAt: number; partyRoomId?: string; globalInviteSentAt?: number; startAttempts?: number };

const QUICK_BROADCAST_AFTER_MS = 10_000;
const QUICK_AI_FILL_AFTER_MS = 20_000;
const PARTY_BROADCAST_AFTER_MS = 60_000;
const PARTY_AI_FILL_AFTER_MS = 120_000;
const PARTY_LOBBY_INDEX = 'ayo:party:lobbies';
const PARTY_START_MAX_ATTEMPTS = 20; // a lobby whose start keeps failing is closed after this many one-second retries

const QUEUE_KEY = 'ayo:quick-queue';
const ROOM_PREFIX = 'ayo:room:';
const STATE_PREFIX = 'ayo:state:';
const TICKET_PREFIX = 'ayo:ticket:';
const LOCK_PREFIX = 'ayo:lock:';
const ACTIVE_SET = 'ayo:active';
const ROOM_MATCH_PREFIX = 'ayo:room-match:';
const DEFINITION_CACHE_MS = 15_000;
const DISCONNECT_GRACE_SECONDS = 60;

@Injectable()
export class AyoService implements OnModuleDestroy {
  private readonly redis: IORedis;
  private readonly localRooms = new Map<string, AyoRoom>();
  private readonly localStates = new Map<string, AyoState>();
  private readonly localTickets = new Map<string, any>();
  private readonly localLocks = new Set<string>();
  private localQueue: WaitingPlayer[] = [];
  private definitionCache: { at: number; game: any } | null = null;
  private activeSetMigrated = false;
  private readonly logger = new Logger(AyoService.name);
  private readonly warned = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly rounds: RoundService,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimeGateway,
  ) {
    this.redis = new IORedis(this.configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 1, enableOfflineQueue: false,
    });
    this.redis.on('error', () => undefined);
  }

  async onModuleDestroy() { await this.redis.quit().catch(() => undefined); }

  async ensureDefinition() {
    // Cached: this used to be a DB upsert on every request and on every bot move every second,
    // which alone kept the small connection pool busy. Admin rule changes apply within 15s.
    if (this.definitionCache && Date.now() - this.definitionCache.at < DEFINITION_CACHE_MS) return this.definitionCache.game;
    const found = await this.prisma.gameDefinition.findUnique({ where: { code: 'AYO' } });
    const game = found ?? await this.createDefinition();
    this.definitionCache = { at: Date.now(), game };
    return game;
  }

  private async createDefinition() {
    return this.prisma.gameDefinition.upsert({
      where: { code: 'AYO' },
      update: {},
      create: {
        code: 'AYO', name: 'Ayo', status: 'DISABLED', version: 1,
        rulesJson: {
          minEntry: 100, maxEntry: 500000, turnSeconds: 30,
          prizePercent: 95, captureMode: 'TWO_THREE',
        },
      },
    });
  }

  async config() {
    const game = await this.ensureDefinition();
    return game.rulesJson ?? {};
  }

  private async readState(matchId: string): Promise<AyoState | null> {
    const raw = await this.redis.get(`${STATE_PREFIX}${matchId}`).catch(() => null);
    if (raw) return JSON.parse(raw);
    return this.localStates.get(matchId) ?? null;
  }

  private async writeState(state: AyoState) {
    this.localStates.set(state.matchId, state);
    await this.redis.set(`${STATE_PREFIX}${state.matchId}`, JSON.stringify(state), 'EX', 86400).catch(() => undefined);
    await this.redis.set(`${ROOM_MATCH_PREFIX}${state.roomCode}`, state.matchId, 'EX', 86400).catch(() => undefined);
    if (state.status === 'ACTIVE') await this.redis.sadd(ACTIVE_SET, state.matchId).catch(() => undefined);
    else {
      await this.redis.srem(ACTIVE_SET, state.matchId).catch(() => undefined);
      // keep memory bounded on the in-process fallback
      if (this.localStates.size > 500) this.localStates.delete(state.matchId);
    }
  }

  private async readRoom(code: string): Promise<AyoRoom | null> {
    const key = code.toUpperCase();
    const raw = await this.redis.get(`${ROOM_PREFIX}${key}`).catch(() => null);
    if (raw) return JSON.parse(raw);
    return this.localRooms.get(key) ?? null;
  }

  private async writeRoom(room: AyoRoom) {
    this.localRooms.set(room.roomCode, room);
    await this.redis.set(`${ROOM_PREFIX}${room.roomCode}`, JSON.stringify(room), 'EX', 3600).catch(() => undefined);
  }

  private async requireBalance(userId: string, amount: number) {
    if (await this.wallet.getBalance(userId, WalletType.COIN) < BigInt(amount)) {
      throw new BadRequestException('Insufficient balance');
    }
  }

  private makeRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>, ttlMs = 12000): Promise<T> {
    const token = uuid();
    const acquired = await this.redis.set(`${LOCK_PREFIX}${key}`, token, 'PX', ttlMs, 'NX').catch(() => 'REDIS_DOWN' as const);
    if (acquired === 'REDIS_DOWN') {
      // Redis unreachable: use a process-local lock so single-instance play still works.
      if (this.localLocks.has(key)) throw new BadRequestException('Ayo matchmaking is busy. Please try again.');
      this.localLocks.add(key);
      try { return await fn(); } finally { this.localLocks.delete(key); }
    }
    if (acquired !== 'OK') throw new BadRequestException('Ayo matchmaking is busy. Please try again.');
    try { return await fn(); } finally {
      await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `${LOCK_PREFIX}${key}`, token).catch(() => undefined);
    }
  }

  private async startMatch(room: AyoRoom) {
    const game = await this.ensureDefinition();
    const rules = (game.rulesJson ?? {}) as any;
    const turnSeconds = Math.max(10, Number(rules.turnSeconds ?? 30));
    const matchId = room.matchId;
    const now = new Date();

    await this.prisma.$transaction(async tx => {
      for (const p of room.players.filter(p => !p.userId.startsWith('bot:'))) {
        await this.wallet.debit({
          userId: p.userId, walletType: WalletType.COIN, amount: BigInt(room.entryFee),
          ledgerType: LedgerEntryType.GAME_ENTRY, reference: matchId,
          idempotencyKey: `ayo:entry:${matchId}:${p.userId}`,
        }, tx);
      }
      await tx.gameRound.create({
        data: {
          id: matchId, gameCode: 'AYO', rulesVersion: game.version,
          entryPrice: room.entryFee, openAt: now,
          lockAt: new Date(now.getTime() + turnSeconds * 1000),
          status: 'OPEN', hiddenState: {} as any,
        },
      });
      for (const p of room.players.filter(p => !p.userId.startsWith('bot:'))) {
        await tx.gameEntry.create({
          data: {
            roundId: matchId, userId: p.userId,
            selection: { roomCode: room.roomCode, seat: room.players.indexOf(p) },
            coinAmount: room.entryFee,
            idempotencyKey: `ayo:entry-record:${matchId}:${p.userId}`,
          },
        });
      }
    }, { maxWait: 15000, timeout: 60000 });

    const state = createInitialAyoState({
      matchId, roomCode: room.roomCode, entryFee: room.entryFee,
      players: room.players.map((p, i) => ({ userId: p.userId, displayName: p.displayName, seat: i as 0 | 1 })),
      turnSeconds,
    });
    state.prizePool = room.entryFee * room.players.length;
    state.prizePayout = Math.floor(state.prizePool * Math.max(0, Math.min(100, Number(rules.prizePercent ?? 95))) / 100);
    await this.writeState(state);
    await this.redis.del(`${ROOM_PREFIX}${room.roomCode}`).catch(() => undefined);
    this.localRooms.delete(room.roomCode);
    if (room.partyRoomId) {
      await this.redis.zrem(PARTY_LOBBY_INDEX, room.roomCode).catch(() => undefined);
      await this.writeQueue((await this.readQueue()).filter(p => !room.players.some(rp => rp.ticket === p.ticket || rp.userId === p.userId)));
      for (const p of room.players.filter(p => !p.userId.startsWith('bot:'))) await this.redis.del(`ayo:user-ticket:${p.userId}`).catch(() => undefined);
    }
    // Push the FULL state to anyone already listening on this match (e.g. the room creator who
    // has been waiting on the socket). A partial payload here used to overwrite the client's state
    // with no board/pot and leave the creator stuck.
    this.broadcast(state);
    if (room.partyRoomId) {
      await this.redis.set(`ayo:party:${room.partyRoomId}`, room.roomCode, 'EX', 3600).catch(() => undefined);
      this.broadcastPartyAyo(room, 'STARTED');
    }
    return state;
  }

  // Same shape as Ludo's own broadcastPartyLudo, deliberately — the Party Room client already
  // knows how to render one game-table banner per game; this just gives it Ayo's version of the
  // same event under its own action name.
  private broadcastPartyAyo(room: AyoRoom | undefined, action: 'STARTED' | 'WAITING' | 'UPDATED' | 'FINISHED') {
    if (!room?.partyRoomId) return;
    this.realtime.broadcastRoomState(room.partyRoomId, {
      roomId: room.partyRoomId,
      action: `AYO_${action}`,
      ayo: {
        status: action === 'FINISHED' ? 'NONE' : (action === 'STARTED' ? 'STARTED' : 'WAITING'),
        matchId: room.matchId,
        roomCode: room.roomCode,
        players: room.players.length,
        partyRoomId: room.partyRoomId,
      },
    });
  }

  async quickMatch(userId: string, displayName: string, entryFee: number, countryCode = 'NG') {
    const t0 = Date.now();
    try {
      return await this.quickMatchInner(userId, displayName, entryFee, countryCode);
    } finally {
      const ms = Date.now() - t0;
      if (ms > 3000) this.logger.warn(`Ayo quick-match for ${userId} took ${ms}ms — check DB pool / Redis latency`);
    }
  }

  private async quickMatchInner(userId: string, displayName: string, entryFee: number, countryCode = 'NG') {
    const game = await this.ensureDefinition();
    await this.rounds.assertGameAvailable('AYO', countryCode);
    const rules = (game.rulesJson ?? {}) as any;
    if (!Number.isInteger(entryFee) || entryFee < Number(rules.minEntry ?? 100) || entryFee > Number(rules.maxEntry ?? 500000)) {
      throw new BadRequestException('Invalid Ayo entry amount');
    }
    await this.requireBalance(userId, entryFee);
    const existing = await this.redis.get(`ayo:user-ticket:${userId}`).catch(() => null);
    if (existing) {
      const t = await this.readTicket(existing);
      if (t?.status === 'WAITING' && Number(t.entryFee) === entryFee) {
        const queue = await this.readQueue();
        // Ticket survived but its queue entry was lost (expired/overwritten): put it back, otherwise
        // the player waits forever and neither a human nor the AI fill ever picks them up.
        if (!queue.some(p => p.ticket === t.ticket)) {
          await this.writeQueue([...queue.filter(p => p.userId !== userId), { userId, displayName, entryFee, ticket: t.ticket }]);
        }
        return { ...t, queueAhead: Math.max(0, queue.filter(p => p.entryFee === t.entryFee && p.ticket !== t.ticket).length) };
      }
      if (t?.status === 'WAITING') {
        // Searching at a different fee now: drop the old search first.
        await this.cancelQuick(userId, t.ticket).catch(() => undefined);
      }
    }
    return this.withLock(`queue:${entryFee}`, async () => {
      const ticket = uuid();
      const player: WaitingPlayer = { userId, displayName, entryFee, ticket };
      let queue = await this.readQueue();
      queue = queue.filter(p => p.userId !== userId);
      const match = queue.find(p => p.entryFee === entryFee && p.userId !== userId);
      if (match) {
        const remaining = queue.filter(p => p.ticket !== match.ticket);
        await this.writeQueue(remaining);
        const room: AyoRoom = {
          matchId: match.matchId ?? uuid(), roomCode: match.roomCode ?? this.makeRoomCode(), entryFee,
          players: [match, player], createdAt: Date.now(), partyRoomId: match.partyRoomId,
        };
        const state = await this.startMatch(room);
        const done = { status: 'STARTED', ticket, matchId: state.matchId, roomCode: state.roomCode, players: 2, state };
        await this.writeTicket(done);
        const other = await this.readTicket(match.ticket);
        if (other) await this.writeTicket({ ...other, status: 'STARTED', matchId: state.matchId, roomCode: state.roomCode, players: 2, state });
        await this.redis.del(`ayo:user-ticket:${match.userId}`).catch(() => undefined);
        await this.redis.del(`ayo:user-ticket:${userId}`).catch(() => undefined);
        if (match.partyRoomId) await this.redis.del(`ayo:party:${match.partyRoomId}`).catch(() => undefined);
        return done;
      }
      await this.writeQueue([...queue, player]);
      const waiting = { status: 'WAITING', ticket, players: 1, entryFee, createdAt: new Date().toISOString(), globalInviteSentAt: null };
      await this.writeTicket({ ...waiting, userId });
      await this.redis.set(`ayo:user-ticket:${userId}`, ticket, 'EX', 900).catch(() => undefined);
      return waiting;
    });
  }

  private async readQueue(): Promise<WaitingPlayer[]> {
    const raw = await this.redis.get(QUEUE_KEY).catch(() => undefined);
    if (raw === undefined) return this.localQueue.slice();
    return raw ? JSON.parse(raw) : [];
  }

  private async writeQueue(queue: WaitingPlayer[]) {
    this.localQueue = queue.slice();
    await this.redis.set(QUEUE_KEY, JSON.stringify(queue), 'EX', 900).catch(() => undefined);
  }

  private async readTicket(ticket: string) {
    const raw = await this.redis.get(`${TICKET_PREFIX}${ticket}`).catch(() => null);
    return raw ? JSON.parse(raw) : this.localTickets.get(ticket) ?? null;
  }

  private async writeTicket(ticket: any) {
    this.localTickets.set(ticket.ticket, ticket);
    await this.redis.set(`${TICKET_PREFIX}${ticket.ticket}`, JSON.stringify(ticket), 'EX', ticket.status === 'WAITING' ? 900 : 86400).catch(() => undefined);
  }

  async quickStatus(userId: string, ticket: string) {
    const t = await this.readTicket(ticket);
    if (!t || (t.userId && t.userId !== userId && t.status === 'WAITING')) throw new NotFoundException('Ayo search expired');
    return t;
  }

  async cancelQuick(userId: string, ticket: string) {
    const t = await this.readTicket(ticket);
    if (!t || t.userId !== userId) throw new BadRequestException('Invalid Ayo ticket');
    if (t.status !== 'WAITING') return t;
    await this.writeQueue((await this.readQueue()).filter(p => p.ticket !== ticket && p.userId !== userId));
    await this.redis.del(`ayo:user-ticket:${userId}`).catch(() => undefined);
    t.status = 'CANCELLED';
    await this.writeTicket(t);
    return t;
  }

  async createRoom(userId: string, displayName: string, entryFee: number, countryCode = 'NG', partyRoomId?: string) {
    await this.rounds.assertGameAvailable('AYO', countryCode);
    const rules = (await this.config()) as any;
    if (!Number.isInteger(entryFee) || entryFee < Number(rules.minEntry ?? 100) || entryFee > Number(rules.maxEntry ?? 500000)) throw new BadRequestException('Invalid Ayo entry amount');
    await this.requireBalance(userId, entryFee);
    const room: AyoRoom = { matchId: uuid(), roomCode: this.makeRoomCode(), entryFee, players: [{ userId, displayName, entryFee, ticket: uuid() }], createdAt: Date.now(), partyRoomId };
    await this.writeRoom(room);
    if (partyRoomId) {
      await this.redis.set(`ayo:party:${partyRoomId}`, room.roomCode, 'EX', 3600).catch(() => undefined);
      await this.redis.zadd(PARTY_LOBBY_INDEX, room.createdAt, room.roomCode).catch(() => undefined);
      this.broadcastPartyAyo(room, 'WAITING');
    }
    return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: 1, entryFee, partyRoomId };
  }

  async joinRoom(userId: string, displayName: string, roomCode: string, countryCode = 'NG') {
    await this.rounds.assertGameAvailable('AYO', countryCode);
    return this.withLock(`room:${roomCode.toUpperCase()}`, async () => {
      const room = await this.readRoom(roomCode);
      if (!room) {
        // Room already started (or the code was typed for a running match): if this user is one
        // of the seated players, hand them the live match instead of a confusing "not found".
        const live = await this.findStateByRoom(roomCode);
        if (live && live.status === 'ACTIVE' && live.players.some(p => p.userId === userId)) {
          return { status: 'STARTED', matchId: live.matchId, roomCode: live.roomCode, players: 2, entryFee: live.entryFee, state: { ...live, serverNow: Date.now() } };
        }
        if (live) throw new BadRequestException('This Ayo match has already started');
        throw new NotFoundException('Ayo room not found');
      }
      if (room.players.some(p => p.userId === userId)) return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: room.players.length, entryFee: room.entryFee };
      if (room.players.length >= 2) throw new BadRequestException('Ayo room is full');
      await this.requireBalance(userId, room.entryFee);
      room.players.push({ userId, displayName, entryFee: room.entryFee, ticket: uuid() });
      const state = await this.startMatch(room);
      return { status: 'STARTED', matchId: state.matchId, roomCode: state.roomCode, players: 2, entryFee: room.entryFee, state };
    });
  }

  async roomStatus(userId: string, roomCode: string) {
    const room = await this.readRoom(roomCode);
    if (!room) {
      const state = await this.findStateByRoom(roomCode);
      if (!state) throw new NotFoundException('Ayo room not found');
      // Clients poll this while waiting for an opponent and look for 'STARTED' — report a live
      // match as STARTED (not the raw 'ACTIVE') so the room creator actually enters the game.
      const status = state.status === 'ACTIVE' ? 'STARTED' : state.status;
      return { status, matchId: state.matchId, roomCode: state.roomCode, players: state.players.length, entryFee: state.entryFee, state: { ...state, serverNow: Date.now() } };
    }
    if (!room.players.some(p => p.userId === userId)) throw new BadRequestException('You are not in this Ayo room');
    return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: room.players.length, entryFee: room.entryFee };
  }

  private async findStateByRoom(roomCode: string) {
    const code = roomCode.toUpperCase();
    const indexed = await this.redis.get(`${ROOM_MATCH_PREFIX}${code}`).catch(() => null);
    if (indexed) {
      const st = await this.readState(indexed);
      if (st) return st;
    }
    for (const state of this.localStates.values()) if (state.roomCode === code) return state;
    const keys = await this.redis.keys(`${STATE_PREFIX}*`).catch(() => []);
    for (const key of keys) {
      const raw = await this.redis.get(key).catch(() => null);
      if (raw) {
        const state = JSON.parse(raw) as AyoState;
        if (state.roomCode === code) return state;
      }
    }
    for (const state of this.localStates.values()) if (state.roomCode === code) return state;
    return null;
  }

  async setConnection(userId: string, matchId: string, connected: boolean) {
    const state = await this.readState(matchId);
    if (!state || state.status !== 'ACTIVE') return state;
    const seat = state.players.findIndex(p => p.userId === userId);
    if (seat < 0) return state;
    state.players[seat].connected = connected;
    if (!state.disconnectedAt) state.disconnectedAt = [null, null];
    state.disconnectedAt[seat as 0 | 1] = connected ? null : Date.now();
    state.serverNow = Date.now();
    await this.writeState(state);
    this.broadcast(state);
    return state;
  }

  async getState(matchId: string) {
    const state = await this.readState(matchId);
    if (!state) throw new NotFoundException('Ayo match not found');
    return { ...state, serverNow: Date.now() };
  }

  async move(userId: string, matchId: string, pit: number) {
    return this.withLock(`match:${matchId}`, () => this.moveLocked(userId, matchId, pit));
  }

  private async moveLocked(userId: string, matchId: string, pit: number) {
    const state = await this.readState(matchId);
    if (!state) throw new NotFoundException('Ayo match not found');
    if (state.status !== 'ACTIVE') throw new BadRequestException('Ayo match is not active');
    const player = state.players[state.currentSeat];
    const seat = state.players.findIndex(p => p.userId === userId);
    if (seat >= 0 && !state.players[seat].connected) { state.players[seat].connected = true; if (state.disconnectedAt) state.disconnectedAt[seat as 0 | 1] = null; }
    if (!player || player.userId !== userId) throw new BadRequestException('It is not your turn');
    if (Date.parse(state.turnExpiresAt) <= Date.now()) {
      await this.advanceExpired(state);
      throw new BadRequestException('Your turn expired');
    }

    const game = await this.ensureDefinition();
    const rules = (game.rulesJson ?? {}) as any;
    const beforeCaptured = state.captured[state.currentSeat];
    let result;
    try {
      result = makeMove(state, Number(pit), (rules.captureMode === 'FOUR' ? 'FOUR' : 'TWO_THREE') as AyoCaptureMode);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Invalid Ayo move');
    }

    const now = Date.now();
    state.board = result.board;
    state.captured = result.captured;
    state.lastMove = { seat: state.currentSeat, pit: Number(pit), captured: result.captured[state.currentSeat] - beforeCaptured, path: result.path };
    state.turnNumber += 1;
    if (result.finished) {
      state.status = 'FINISHED';
      const gameRules = (rules ?? {}) as any;
      state.prizePool = state.entryFee * state.players.length;
      state.winnerUserId = result.winnerSeat === null ? undefined : state.players[result.winnerSeat!].userId;
      state.prizePayout = state.winnerUserId ? Math.floor(state.prizePool * Math.max(0, Math.min(100, Number(gameRules.prizePercent ?? 95))) / 100) : state.entryFee;
      state.serverNow = now;
      await this.writeState(state);
      await this.settle(state);
      return state;
    }
    state.currentSeat = result.nextSeat as 0 | 1;
    state.turnStartedAt = new Date(now).toISOString();
    state.turnExpiresAt = new Date(now + state.turnSeconds * 1000).toISOString();
    state.serverNow = now;
    await this.writeState(state);
    this.broadcast(state);
    return state;
  }

  async forfeitDisconnected(state: AyoState) {
    if (state.status !== 'ACTIVE' || !state.disconnectedAt) return state;
    const now = Date.now();
    const grace = (state.reconnectGraceSeconds || DISCONNECT_GRACE_SECONDS) * 1000;
    const expiredSeat = state.disconnectedAt.findIndex(v => v != null && now - Number(v) >= grace);
    if (expiredSeat < 0) return state;
    const winnerSeat = expiredSeat === 0 ? 1 : 0;
    state.status = 'FINISHED';
    state.winnerUserId = state.players[winnerSeat].userId;
    const game = await this.ensureDefinition();
    const rules = (game.rulesJson ?? {}) as any;
    state.prizePool = state.entryFee * state.players.length;
    state.prizePayout = Math.floor(state.prizePool * Math.max(0, Math.min(100, Number(rules.prizePercent ?? 95))) / 100);
    state.serverNow = now;
    await this.writeState(state);
    await this.settle(state);
    return state;
  }

  async advanceExpired(state: AyoState) {
    if (state.status !== 'ACTIVE' || Date.parse(state.turnExpiresAt) > Date.now()) return state;
    // Ayo should never stall because a player disappeared. For a timed game,
    // an expired turn simply passes to the opponent; no seeds are moved.
    state.currentSeat = state.currentSeat === 0 ? 1 : 0;
    const now = Date.now();
    state.turnNumber += 1;
    state.turnStartedAt = new Date(now).toISOString();
    state.turnExpiresAt = new Date(now + state.turnSeconds * 1000).toISOString();
    state.serverNow = now;
    await this.writeState(state);
    this.broadcast(state);
    return state;
  }

  private async settle(state: AyoState) {
    const game = await this.ensureDefinition();
    const rules = (game.rulesJson ?? {}) as any;
    const prizePercent = Math.max(0, Math.min(100, Number(rules.prizePercent ?? 95)));
    const pool = state.entryFee * state.players.length;
    const prize = state.winnerUserId ? Math.floor(pool * prizePercent / 100) : 0;

    // Spectator bets settle in the SAME transaction as the players' own payouts, so a crash
    // partway through can never leave one side paid and the other not. Ayo only ever has a
    // single winner (or a refunded draw) — no second-place split like Ludo's 4-player mode — so
    // this is simpler than LudoService's equivalent: exactly one winner-take-pool payout, or
    // nothing at all on a draw.
    const spectatorBets = state.winnerUserId ? await this.prisma.ayoSpectatorBet.findMany({ where: { matchId: state.matchId, status: 'PLACED' } }) : [];
    const spectatorPool = spectatorBets.reduce((sum, bet) => sum + bet.coinAmount, 0);
    const spectatorSplit = spectatorPool > 0 ? calculateSpectatorPoolSplit(spectatorPool) : null;
    const winningSpectatorStake = state.winnerUserId
      ? spectatorBets.filter(bet => bet.playerUserId === state.winnerUserId).reduce((sum, bet) => sum + bet.coinAmount, 0)
      : 0;

    await this.prisma.$transaction(async tx => {
      await tx.gameRound.update({
        where: { id: state.matchId },
        data: { status: 'SETTLED', result: { winnerUserId: state.winnerUserId ?? null, captured: state.captured, board: state.board }, settledAt: new Date(), hiddenState: state as any },
      });
      const entries = await tx.gameEntry.findMany({ where: { roundId: state.matchId } });
      for (const entry of entries) {
        if (!state.winnerUserId) {
          await tx.gameEntry.update({ where: { id: entry.id }, data: { status: 'REFUNDED', rewardAmount: entry.coinAmount, netAmount: 0 } });
          await this.wallet.credit({
            userId: entry.userId, walletType: WalletType.COIN, amount: BigInt(entry.coinAmount),
            ledgerType: LedgerEntryType.REFUND, reference: entry.id,
            idempotencyKey: `ayo:draw-refund:${entry.id}`,
          }, tx);
          continue;
        }
        const won = state.winnerUserId === entry.userId;
        await tx.gameEntry.update({ where: { id: entry.id }, data: { status: won ? 'WON' : 'LOST', rewardAmount: won ? prize : 0, netAmount: won ? prize - entry.coinAmount : -entry.coinAmount } });
        if (won && prize > 0) {
          await this.wallet.credit({
            userId: entry.userId, walletType: WalletType.COIN, amount: BigInt(prize),
            ledgerType: LedgerEntryType.GAME_REWARD, reference: entry.id,
            idempotencyKey: `ayo:reward:${entry.id}`,
          }, tx);
        }
      }

      if (state.winnerUserId && spectatorSplit && spectatorBets.length > 0) {
        // A bonus to the winning PLAYER themself for having backers — same 20% share Ludo pays.
        if (spectatorSplit.winner > 0) {
          const winnerEntry = entries.find(e => e.userId === state.winnerUserId);
          if (winnerEntry) {
            await this.wallet.credit({ userId: state.winnerUserId, walletType: WalletType.COIN, amount: BigInt(spectatorSplit.winner), ledgerType: LedgerEntryType.GAME_REWARD, reference: winnerEntry.id, idempotencyKey: `ayo_spectator_winner:${state.matchId}` }, tx);
          }
        }
        for (const bet of spectatorBets) {
          const reward = bet.playerUserId === state.winnerUserId && winningSpectatorStake > 0
            ? calculateWinningSpectatorReward(spectatorSplit.spectators, bet.coinAmount, winningSpectatorStake)
            : 0;
          if (reward > 0) {
            await this.wallet.credit({ userId: bet.userId, walletType: WalletType.COIN, amount: BigInt(reward), ledgerType: LedgerEntryType.GAME_REWARD, reference: bet.id, idempotencyKey: `ayo_spectator_reward:${bet.id}` }, tx);
          }
          await tx.ayoSpectatorBet.update({ where: { id: bet.id }, data: { status: reward > 0 ? 'WON' : 'LOST', rewardAmount: reward, settledAt: new Date() } });
        }
      } else if (spectatorBets.length > 0) {
        await tx.ayoSpectatorBet.updateMany({ where: { matchId: state.matchId, status: 'PLACED' }, data: { status: 'LOST', rewardAmount: 0, settledAt: new Date() } });
      }
    });

    this.broadcast(state);
    // Stop advertising a live table the instant the match ends — the completed result stays
    // available through the normal match/history endpoints, but Party Room must not keep
    // showing a game that is actually over.
    const partyRoomId = await this.partyRoomIdForMatch(state.roomCode);
    if (partyRoomId) {
      this.broadcastPartyAyo({ matchId: state.matchId, roomCode: state.roomCode, entryFee: state.entryFee, players: [], createdAt: 0, partyRoomId }, 'FINISHED');
      await this.redis.del(`ayo:party:${partyRoomId}`).catch(() => undefined);
    }
  }

  private broadcast(state: AyoState) {
    this.realtime.broadcastAyo(state.matchId, { ...state, serverNow: Date.now() });
  }

  private async activeMatchIds(): Promise<string[]> {
    if (!this.activeSetMigrated) {
      // One-time: index matches that were already running before this version was deployed.
      const keys = await this.redis.keys(`${STATE_PREFIX}*`).catch(() => null);
      if (keys) {
        for (const key of keys) {
          const raw = await this.redis.get(key).catch(() => null);
          if (!raw) continue;
          const st = JSON.parse(raw) as AyoState;
          if (st.status === 'ACTIVE') await this.redis.sadd(ACTIVE_SET, st.matchId).catch(() => undefined);
        }
        this.activeSetMigrated = true;
      }
    }
    const ids = await this.redis.smembers(ACTIVE_SET).catch(() => null);
    if (ids) return ids;
    return [...this.localStates.values()].filter(s => s.status === 'ACTIVE').map(s => s.matchId);
  }

  async tick() {
    await this.processAyoWaiting().catch(() => undefined);
    const ids = await this.activeMatchIds();
    for (const id of ids) {
      const state = await this.readState(id);
      if (!state) { await this.redis.srem(ACTIVE_SET, id).catch(() => undefined); continue; }
      if (state.status !== 'ACTIVE') { await this.redis.srem(ACTIVE_SET, id).catch(() => undefined); continue; }
      await this.withLock(`match:${state.matchId}`, async () => {
        const fresh = await this.readState(state.matchId);
        if (!fresh || fresh.status !== 'ACTIVE') return;
        const current = fresh.players[fresh.currentSeat];
        if (current?.userId.startsWith('bot:')) {
          const game = await this.ensureDefinition();
          const rules = (game.rulesJson ?? {}) as any;
          const mode = (rules.captureMode === 'FOUR' ? 'FOUR' : 'TWO_THREE') as AyoCaptureMode;
          // Only consider moves the rules accept (e.g. mandatory feeding); prefer captures a bit.
          const options = legalPits(fresh.board, fresh.currentSeat).flatMap(p => {
            try { return [{ pit: p, gain: makeMove(fresh, p, mode).captured[fresh.currentSeat] - fresh.captured[fresh.currentSeat] }]; } catch { return []; }
          });
          if (!options.length) { await this.advanceExpired(fresh); return; }
          const best = Math.max(...options.map(o => o.gain));
          const pool = best > 0 && randomInt(100) < 70 ? options.filter(o => o.gain === best) : options;
          const pit = pool[randomInt(pool.length)].pit;
          try {
            const result = makeMove(fresh, pit, (rules.captureMode === 'FOUR' ? 'FOUR' : 'TWO_THREE') as AyoCaptureMode);
            const before = fresh.captured[fresh.currentSeat];
            fresh.board = result.board;
            fresh.captured = result.captured;
            fresh.lastMove = { seat: fresh.currentSeat, pit, captured: result.captured[fresh.currentSeat] - before, path: result.path };
            fresh.turnNumber += 1;
            if (result.finished) {
              fresh.status = 'FINISHED';
              fresh.winnerUserId = result.winnerSeat === null ? undefined : fresh.players[result.winnerSeat!].userId;
              fresh.prizePayout = fresh.winnerUserId && !fresh.winnerUserId.startsWith('bot:') ? Math.floor(fresh.prizePool * Number(rules.prizePercent ?? 95) / 100) : 0;
              fresh.serverNow = Date.now();
              await this.writeState(fresh);
              await this.settle(fresh);
            } else {
              fresh.currentSeat = result.nextSeat as 0 | 1;
              const now2 = Date.now();
              fresh.turnStartedAt = new Date(now2).toISOString();
              fresh.turnExpiresAt = new Date(now2 + fresh.turnSeconds * 1000).toISOString();
              fresh.serverNow = now2;
              await this.writeState(fresh);
              this.broadcast(fresh);
            }
          } catch { await this.advanceExpired(fresh); }
          return;
        }
        if (Date.parse(fresh.turnExpiresAt) <= Date.now()) await this.advanceExpired(fresh);
        if (fresh.disconnectedAt?.some(v => v != null && Date.now() - Number(v) >= (fresh.reconnectGraceSeconds || DISCONNECT_GRACE_SECONDS) * 1000)) await this.forfeitDisconnected(fresh);
      }).catch(() => undefined);
    }
  }

  // ── Party Room hosting + spectator betting (mirrors LudoService exactly) ─────────────

  // What a Party Room's own screen polls to know whether an Ayo table is currently running in
  // it, and to get an "Ayo" button in front of the host and every seated guest. Named to match
  // LudoService's partyRoomStatus exactly, not just its behavior.
  async partyRoomStatus(userId: string, roomId: string) {
    const seat = await this.prisma.roomSeat.findFirst({ where: { roomId, userId }, select: { id: true } });
    const party = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { hostId: true, status: true, privacy: true } });
    if (!party) throw new NotFoundException('Party room not found');
    // Public Party viewers may observe an active Ayo table without occupying a seat. Private
    // rooms still require the host or a seated member — same rule as LudoService.
    if (party.hostId !== userId && !seat && party.privacy !== 'PUBLIC') {
      throw new BadRequestException('Join this Party Room before viewing its Ayo game');
    }
    const isHost = party.hostId === userId;
    const canJoin = isHost || !!seat || party.privacy === 'PUBLIC';
    const code = await this.redis.get(`ayo:party:${roomId}`).catch(() => null);
    if (!code) return { status: 'NONE', partyRoomId: roomId, isHost, canJoin };
    const room = await this.readRoom(code);
    if (room) return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: room.players.length, partyRoomId: roomId, isHost, canJoin };
    const state = await this.findStateByRoom(code);
    if (!state) {
      await this.redis.del(`ayo:party:${roomId}`).catch(() => undefined);
      return { status: 'NONE', partyRoomId: roomId, isHost, canJoin };
    }
    return { status: state.status === 'ACTIVE' ? 'STARTED' : 'NONE', matchId: state.matchId, roomCode: state.roomCode, players: state.players.length, partyRoomId: roomId, isHost, canJoin, state };
  }

  // Host-only, same rule as LudoService.createPartyRoom. If a table is already running in this
  // room, returns it instead of starting a second one.
  async createPartyRoom(userId: string, roomId: string, entryFee: number, countryCode = 'NG') {
    const party = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { id: true, hostId: true, status: true } });
    if (!party) throw new NotFoundException('Party room not found');
    if (party.hostId !== userId) throw new BadRequestException('Only the Party Room host can start Ayo');
    if (party.status !== 'OPEN') throw new BadRequestException('Party room is closed');
    const existingCode = await this.redis.get(`ayo:party:${roomId}`).catch(() => null);
    if (existingCode) {
      const existing = await this.readRoom(existingCode);
      if (existing) return { status: 'WAITING', matchId: existing.matchId, roomCode: existing.roomCode, players: existing.players.length, partyRoomId: roomId };
    }
    const host = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    return this.createRoom(userId, host?.displayName?.trim() || 'Host', entryFee, countryCode, roomId);
  }

  async joinPartyRoom(userId: string, roomId: string, displayName: string, countryCode = 'NG') {
    const party = await this.prisma.partyRoom.findUnique({ where: { id: roomId }, select: { id: true, hostId: true, status: true, privacy: true } });
    if (!party) throw new NotFoundException('Party room not found');
    if (party.status !== 'OPEN') throw new BadRequestException('Party room is closed');
    const seat = await this.prisma.roomSeat.findFirst({ where: { roomId, userId }, select: { id: true } });
    if (party.hostId !== userId && !seat && party.privacy !== 'PUBLIC') {
      throw new BadRequestException('Join the Party Room before joining its Ayo game');
    }
    const code = await this.redis.get(`ayo:party:${roomId}`).catch(() => null);
    if (!code) throw new NotFoundException('The Party Room has not started Ayo');
    // joinRoom also handles "already started and you are a player" by returning the live state.
    return this.joinRoom(userId, displayName, code, countryCode);
  }

  private async assertPartyAyoViewer(userId: string, partyRoomId: string) {
    const party = await this.prisma.partyRoom.findUnique({ where: { id: partyRoomId }, select: { hostId: true, status: true, privacy: true } });
    if (!party || party.status !== 'OPEN') throw new BadRequestException('Party room is closed');
    if (party.hostId === userId || party.privacy === 'PUBLIC') return;
    const seat = await this.prisma.roomSeat.findFirst({ where: { roomId: partyRoomId, userId }, select: { id: true } });
    if (!seat) throw new BadRequestException('Join this Party Room before betting on its Ayo game');
  }

  async spectatorBetStatus(userId: string, matchId: string) {
    const state = await this.getState(matchId);
    const partyRoomId = await this.partyRoomIdForMatch(state.roomCode);
    if (!partyRoomId) throw new NotFoundException('This Ayo match is not in a Party Room');
    await this.assertPartyAyoViewer(userId, partyRoomId);
    const [myBet, aggregate] = await Promise.all([
      this.prisma.ayoSpectatorBet.findUnique({ where: { matchId_userId: { matchId, userId } }, select: { id: true, playerUserId: true, coinAmount: true, rewardAmount: true, status: true } }),
      this.prisma.ayoSpectatorBet.groupBy({ by: ['playerUserId'], where: { matchId }, _sum: { coinAmount: true } }),
    ]);
    const playerPool = aggregate.reduce((sum, row) => sum + (row._sum.coinAmount ?? 0), 0);
    const playerBets = Object.fromEntries(aggregate.map(row => [row.playerUserId, row._sum.coinAmount ?? 0]));
    return { matchId, status: state.status, playerPool, playerBets, myBet };
  }

  async placeSpectatorBet(userId: string, matchId: string, playerUserId: string, amount: number) {
    const state = await this.getState(matchId);
    const partyRoomId = await this.partyRoomIdForMatch(state.roomCode);
    if (!partyRoomId) throw new NotFoundException('This Ayo match is not in a Party Room');
    await this.assertPartyAyoViewer(userId, partyRoomId);
    if (state.status !== 'ACTIVE') throw new BadRequestException('Spectator betting is closed for this match');
    if (!Number.isInteger(amount) || amount < 10 || amount > 500000) throw new BadRequestException('Bet must be between 10 and 500000 coins');
    const player = state.players.find(p => p.userId === playerUserId);
    if (!player) throw new BadRequestException('That player is not in this match');
    if (state.players.some(p => p.userId === userId)) throw new BadRequestException('Players cannot bet on the match as spectators');
    if (playerUserId.startsWith('bot:')) throw new BadRequestException('You can only bet on a human player');

    const idempotencyKey = `ayo_spectator_bet:${matchId}:${userId}`;
    const bet = await this.prisma.$transaction(async tx => {
      const existing = await tx.ayoSpectatorBet.findUnique({ where: { matchId_userId: { matchId, userId } } });
      if (existing) throw new BadRequestException('You already placed a spectator bet on this match');
      const created = await tx.ayoSpectatorBet.create({ data: { matchId, userId, playerUserId, coinAmount: amount, idempotencyKey } });
      await this.wallet.debit({ userId, walletType: WalletType.COIN, amount: BigInt(amount), ledgerType: LedgerEntryType.GAME_ENTRY, reference: created.id, idempotencyKey: `ayo_spectator_debit:${created.id}` }, tx);
      return created;
    });

    const status = await this.spectatorBetStatus(userId, matchId);
    return { bet: { id: bet.id, playerUserId: bet.playerUserId, coinAmount: bet.coinAmount, status: bet.status }, ...status };
  }

  // The Redis party mapping is keyed by partyRoomId -> roomCode (see startMatch/createRoom), so
  // recovering the direction this needs (roomCode -> partyRoomId) means a short reverse scan —
  // cheap and rare, since it only runs when a spectator actually opens the betting panel, not on
  // every move.
  private async partyRoomIdForMatch(roomCode: string): Promise<string | null> {
    const keys = await this.redis.keys('ayo:party:*').catch(() => []);
    for (const key of keys) {
      const code = await this.redis.get(key).catch(() => null);
      if (code === roomCode) return key.replace('ayo:party:', '');
    }
    return null;
  }

  private randomBotName(): string {
    return randomPlayerName();
  }

  private async startAyoWithAi(room: AyoRoom) {
    if (room.players.length >= 2) return this.startMatch(room);
    const ai: WaitingPlayer = {
      userId: `bot:${uuid()}`,
      displayName: this.randomBotName(),
      entryFee: room.entryFee,
      ticket: uuid(),
    };
    return this.startMatch({ ...room, players: [...room.players, ai] });
  }

  private warnThrottled(key: string, message: string) {
    const now = Date.now();
    if (now - (this.warned.get(key) ?? 0) < 30_000) return;
    this.warned.set(key, now);
    this.logger.warn(message);
  }

  private async processAyoWaiting() {
    const now = Date.now();
    const queue = await this.readQueue();
    const keep: WaitingPlayer[] = [];
    for (const item of queue) {
      // One search that cannot start (the player spent their coins, a database blip) must not stop the
      // other searches, and above all must not stop the Party Room lobbies handled further down.
      try {
        const ticket = await this.readTicket(item.ticket);
        if (!ticket || ticket.status !== 'WAITING') continue;
        const createdAt = Date.parse(ticket.createdAt ?? '') || now;
        if (!ticket.globalInviteSentAt && now - createdAt >= QUICK_BROADCAST_AFTER_MS) {
          ticket.globalInviteSentAt = now;
          await this.writeTicket(ticket);
          this.realtime.broadcastGlobal('ayo:global-invite', {
            type: 'QUICK_AYO_OPEN', entryFee: item.entryFee, players: 1, playerCount: 2,
            expiresAt: new Date(createdAt + QUICK_AI_FILL_AFTER_MS).toISOString(),
          });
        }
        if (now - createdAt >= QUICK_AI_FILL_AFTER_MS) {
          // Same lock as quickMatch(): a real player joining at this exact second can't also
          // start a match with this player (that used to double-start and double-charge).
          const started = await this.withLock(`queue:${item.entryFee}`, async () => {
            const fresh = await this.readTicket(item.ticket);
            if (!fresh || fresh.status !== 'WAITING') return true; // a human got them first
            const stillQueued = (await this.readQueue()).some(p => p.ticket === item.ticket);
            if (!stillQueued) return true;
            const room: AyoRoom = { matchId: item.matchId ?? uuid(), roomCode: this.makeRoomCode(), entryFee: item.entryFee, players: [item], createdAt, partyRoomId: item.partyRoomId };
            const state = await this.startAyoWithAi(room);
            await this.writeTicket({ ...fresh, status: 'STARTED', matchId: state.matchId, roomCode: state.roomCode, players: 2, state });
            await this.redis.del(`ayo:user-ticket:${item.userId}`).catch(() => undefined);
            await this.writeQueue((await this.readQueue()).filter(p => p.ticket !== item.ticket));
            return true;
          }).catch(e => { if (e instanceof BadRequestException && /busy/i.test(e.message)) return false; throw e; });
          if (started) continue;
        }
        keep.push(item);
      } catch (e) {
        const permanent = e instanceof BadRequestException || e instanceof NotFoundException;
        this.warnThrottled(`quick-${item.ticket}`, `Ayo quick-match search ${item.ticket} could not start: ${(e as Error)?.message}`);
        if (permanent) {
          // E.g. not enough coins any more: end this search so it stops failing every second.
          const t = await this.readTicket(item.ticket).catch(() => null);
          if (t) await this.writeTicket({ ...t, status: 'CANCELLED' }).catch(() => undefined);
          await this.redis.del(`ayo:user-ticket:${item.userId}`).catch(() => undefined);
        } else {
          keep.push(item); // transient (database/Redis): try again next second
        }
      }
    }
    // Merge rather than overwrite: players may have joined/left the queue while we were working.
    const removed = new Set(queue.filter(q => !keep.some(k => k.ticket === q.ticket)).map(q => q.ticket));
    if (removed.size) await this.writeQueue((await this.readQueue()).filter(p => !removed.has(p.ticket)));

    let codes: string[] = [];
    try { codes = await this.redis.zrangebyscore(PARTY_LOBBY_INDEX, 0, now); } catch { return; }
    for (const code of codes) {
      try { await this.tickPartyLobby(code, now); } catch (e) {
        this.warnThrottled(`lobby-${code}`, `Party Ayo lobby ${code} tick failed: ${(e as Error)?.message}`);
      }
    }
  }

  /**
   * A Party Room lobby keeps its own clock: a global invite at 60 seconds, and at 120 seconds an ordinary-looking
   * player takes the empty seat. The host is deliberately NOT put into the quick-match queue any more; that second
   * clock filled the same table with a different room code and the two raced each other.
   */
  private async tickPartyLobby(code: string, now: number) {
    const room = await this.readRoom(code);
    if (!room?.partyRoomId || room.players.length >= 2) {
      await this.redis.zrem(PARTY_LOBBY_INDEX, code).catch(() => undefined);
      return;
    }
    const age = now - room.createdAt;
    if (age >= PARTY_BROADCAST_AFTER_MS && age < PARTY_AI_FILL_AFTER_MS && !room.globalInviteSentAt) {
      room.globalInviteSentAt = now;
      await this.writeRoom(room);
      this.realtime.broadcastGlobal('ayo:global-invite', {
        type: 'PARTY_AYO_OPEN', partyRoomId: room.partyRoomId, matchId: room.matchId, roomCode: room.roomCode,
        hostId: room.players[0]?.userId, entryFee: room.entryFee, players: room.players.length, playerCount: 2,
        expiresAt: new Date(room.createdAt + PARTY_AI_FILL_AFTER_MS).toISOString(),
      });
    }
    if (age >= PARTY_AI_FILL_AFTER_MS) await this.fillPartyLobbyWithPlayer(code);
  }

  private async fillPartyLobbyWithPlayer(code: string) {
    try {
      // Same lock as joining, so a real person joining at the very same moment cannot double-start the table.
      await this.withLock(`room:${code}`, async () => {
        const current = await this.readRoom(code);
        if (!current?.partyRoomId || current.players.length >= 2) {
          await this.redis.zrem(PARTY_LOBBY_INDEX, code).catch(() => undefined);
          return;
        }
        try {
          // startMatch removes the lobby from the index and announces the started table.
          await this.startAyoWithAi(current);
        } catch (e) {
          await this.onPartyStartFailed(current, e);
        }
      });
    } catch (e) {
      if (!(e instanceof BadRequestException)) throw e; // BadRequest here only means "busy": the next tick retries
    }
  }

  private async onPartyStartFailed(room: AyoRoom, e: unknown) {
    const message = (e as Error)?.message ?? String(e);
    this.logger.error(`Ayo ${room.roomCode}: could not start: ${message}`);
    const attempts = (room.startAttempts ?? 0) + 1;
    const permanent = e instanceof BadRequestException || e instanceof NotFoundException;
    if (!permanent && attempts < PARTY_START_MAX_ATTEMPTS) {
      room.startAttempts = attempts;
      await this.writeRoom(room); // transient failure: keep the lobby, retry next second
      return;
    }
    // Cannot start (e.g. the host no longer has the entry fee). Nobody was charged; close the lobby.
    this.logger.warn(`Closing Party Ayo lobby ${room.roomCode}: ${message}`);
    if (room.partyRoomId) {
      const mapped = await this.redis.get(`ayo:party:${room.partyRoomId}`).catch(() => null);
      if (mapped === room.roomCode) await this.redis.del(`ayo:party:${room.partyRoomId}`).catch(() => undefined);
    }
    await this.redis.zrem(PARTY_LOBBY_INDEX, room.roomCode).catch(() => undefined);
    await this.redis.del(`${ROOM_PREFIX}${room.roomCode}`).catch(() => undefined);
    this.localRooms.delete(room.roomCode);
    this.broadcastPartyAyo(room, 'FINISHED');
  }

  async quickLobby() {
    const q = await this.readQueue();
    const groups = new Map<number, WaitingPlayer[]>();
    for (const p of q) {
      const arr = groups.get(p.entryFee) ?? [];
      arr.push(p); groups.set(p.entryFee, arr);
    }
    return [...groups.entries()].map(([entryFee, players]) => ({ entryFee, waiting: players.length, players: players.slice(0, 5).map(p => p.displayName) }));
  }
}
