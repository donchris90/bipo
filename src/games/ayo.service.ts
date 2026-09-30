import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LedgerEntryType, WalletType } from '@prisma/client';
import IORedis from 'ioredis';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RoundService } from './round.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AyoCaptureMode, AyoState, createInitialAyoState, legalPits, makeMove } from './ayo.rules';

type WaitingPlayer = { userId: string; displayName: string; entryFee: number; ticket: string };
type AyoRoom = { matchId: string; roomCode: string; entryFee: number; players: WaitingPlayer[]; createdAt: number };

const QUEUE_KEY = 'ayo:quick-queue';
const ROOM_PREFIX = 'ayo:room:';
const STATE_PREFIX = 'ayo:state:';
const TICKET_PREFIX = 'ayo:ticket:';
const LOCK_PREFIX = 'ayo:lock:';
const DISCONNECT_GRACE_SECONDS = 60;

@Injectable()
export class AyoService implements OnModuleDestroy {
  private readonly redis: IORedis;
  private readonly localRooms = new Map<string, AyoRoom>();
  private readonly localStates = new Map<string, AyoState>();
  private readonly localTickets = new Map<string, any>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly rounds: RoundService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeGateway,
  ) {
    this.redis = new IORedis(this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 1, enableOfflineQueue: false,
    });
    this.redis.on('error', () => undefined);
  }

  async onModuleDestroy() { await this.redis.quit().catch(() => undefined); }

  async ensureDefinition() {
    return this.prisma.gameDefinition.upsert({
      where: { code: 'AYO' },
      update: {},
      create: {
        code: 'AYO', name: 'Ayo', status: 'DISABLED', version: 1,
        rulesJson: {
          minEntry: 100, maxEntry: 500000, turnSeconds: 30,
          prizePercent: 95, captureMode: 'FOUR',
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
    const acquired = await this.redis.set(`${LOCK_PREFIX}${key}`, token, 'PX', ttlMs, 'NX').catch(() => null);
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
      for (const p of room.players) {
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
      for (const p of room.players) {
        await tx.gameEntry.create({
          data: {
            roundId: matchId, userId: p.userId,
            selection: { roomCode: room.roomCode, seat: room.players.indexOf(p) },
            coinAmount: room.entryFee,
            idempotencyKey: `ayo:entry-record:${matchId}:${p.userId}`,
          },
        });
      }
    });

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
    this.realtime.broadcastAyo(matchId, {
      matchId, roomCode: room.roomCode, entryFee: room.entryFee,
      players: state.players.map(p => ({ userId: p.userId, displayName: p.displayName })),
    });
    return state;
  }

  async quickMatch(userId: string, displayName: string, entryFee: number, countryCode = 'NG') {
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
      if (t?.status === 'WAITING') return { ...t, queueAhead: Math.max(0, (await this.readQueue()).filter(p => p.entryFee === t.entryFee && p.ticket !== t.ticket).length) };
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
        const room: AyoRoom = { matchId: uuid(), roomCode: this.makeRoomCode(), entryFee, players: [match, player], createdAt: Date.now() };
        const state = await this.startMatch(room);
        const done = { status: 'STARTED', ticket, matchId: state.matchId, roomCode: state.roomCode, players: 2, state };
        await this.writeTicket(done);
        const other = await this.readTicket(match.ticket);
        if (other) await this.writeTicket({ ...other, status: 'STARTED', matchId: state.matchId, roomCode: state.roomCode, players: 2, state });
        await this.redis.del(`ayo:user-ticket:${match.userId}`).catch(() => undefined);
        await this.redis.del(`ayo:user-ticket:${userId}`).catch(() => undefined);
        return done;
      }
      await this.writeQueue([...queue, player]);
      const waiting = { status: 'WAITING', ticket, players: 1, entryFee };
      await this.writeTicket({ ...waiting, userId });
      await this.redis.set(`ayo:user-ticket:${userId}`, ticket, 'EX', 900).catch(() => undefined);
      return waiting;
    });
  }

  private async readQueue(): Promise<WaitingPlayer[]> {
    const raw = await this.redis.get(QUEUE_KEY).catch(() => null);
    return raw ? JSON.parse(raw) : [];
  }

  private async writeQueue(queue: WaitingPlayer[]) {
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
    await this.writeQueue((await this.readQueue()).filter(p => p.ticket !== ticket));
    t.status = 'CANCELLED';
    await this.writeTicket(t);
    return t;
  }

  async createRoom(userId: string, displayName: string, entryFee: number, countryCode = 'NG') {
    await this.rounds.assertGameAvailable('AYO', countryCode);
    const rules = (await this.config()) as any;
    if (!Number.isInteger(entryFee) || entryFee < Number(rules.minEntry ?? 100) || entryFee > Number(rules.maxEntry ?? 500000)) throw new BadRequestException('Invalid Ayo entry amount');
    await this.requireBalance(userId, entryFee);
    const room: AyoRoom = { matchId: uuid(), roomCode: this.makeRoomCode(), entryFee, players: [{ userId, displayName, entryFee, ticket: uuid() }], createdAt: Date.now() };
    await this.writeRoom(room);
    return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: 1, entryFee };
  }

  async joinRoom(userId: string, displayName: string, roomCode: string, countryCode = 'NG') {
    await this.rounds.assertGameAvailable('AYO', countryCode);
    return this.withLock(`room:${roomCode.toUpperCase()}`, async () => {
      const room = await this.readRoom(roomCode);
      if (!room) throw new NotFoundException('Ayo room not found');
      if (room.players.some(p => p.userId === userId)) return { status: 'WAITING', ...room, players: room.players.length };
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
      return { status: state.status, matchId: state.matchId, roomCode: state.roomCode, players: state.players.length, state };
    }
    if (!room.players.some(p => p.userId === userId)) throw new BadRequestException('You are not in this Ayo room');
    return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: room.players.length, entryFee: room.entryFee };
  }

  private async findStateByRoom(roomCode: string) {
    const keys = await this.redis.keys(`${STATE_PREFIX}*`).catch(() => []);
    for (const key of keys) {
      const raw = await this.redis.get(key).catch(() => null);
      if (raw) {
        const state = JSON.parse(raw) as AyoState;
        if (state.roomCode === roomCode) return state;
      }
    }
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
      result = makeMove(state, Number(pit), (rules.captureMode ?? 'FOUR') as AyoCaptureMode);
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
    state.currentSeat = result.nextSeat;
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
    });
    this.broadcast(state);
  }

  private broadcast(state: AyoState) {
    this.realtime.broadcastAyo(state.matchId, { ...state, serverNow: Date.now() });
  }

  async tick() {
    const keys = await this.redis.keys(`${STATE_PREFIX}*`).catch(() => []);
    for (const key of keys) {
      const raw = await this.redis.get(key).catch(() => null);
      if (!raw) continue;
      const state = JSON.parse(raw) as AyoState;
      if (state.status === 'ACTIVE') { await this.withLock(`tick:${state.matchId}`, async () => { const fresh = await this.readState(state.matchId); if (!fresh || fresh.status !== 'ACTIVE') return; if (fresh.disconnectedAt?.some(v => v != null && Date.now() - Number(v) >= (fresh.reconnectGraceSeconds || DISCONNECT_GRACE_SECONDS) * 1000)) { await this.forfeitDisconnected(fresh); return; } if (Date.parse(fresh.turnExpiresAt) <= Date.now()) await this.advanceExpired(fresh); }).catch(() => undefined); }
    }
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
