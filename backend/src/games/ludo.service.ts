import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../economy/wallet.service';
import { RoundService } from './round.service';
import { LedgerEntryType, WalletType } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { randomInt } from 'node:crypto';
import { AUTOPILOT_AFTER_MISSED_TURNS, createLudoState, LudoPlayerState, LudoState, TURN_MS, advanceTurn, applyMove, giveControlBack, handToAi, isAiControlled, legalMoves, pickBotMove, recordFinish, rollForTurn, serverActsAt } from './ludo.rules';

// A search whose app has not checked in for this long is treated as abandoned (the app polls every 2 s).
const STALE_TICKET_MS = 20_000;
// How long Quick Match looks for other people before filling the seats with bots, unless the
// game's rulesJson.botFillSeconds says otherwise (0 switches bot matches off).
const DEFAULT_BOT_FILL_SECONDS = 20;
const BOT_NAMES = ['Ava', 'Max', 'Zara', 'Leo', 'Nia', 'Kai'];

interface QueueItem { userId: string; displayName: string; entryFee: number; playerCount: 2 | 4; ticket?: string; synthetic?: boolean; }
interface QuickTicket { ticket: string; userId: string; entryFee: number; playerCount: 2 | 4; status: 'WAITING' | 'STARTED' | 'CANCELLED'; matchId?: string; roomCode?: string; players?: number; state?: LudoState; createdAt: string; lastSeenAt?: number; }
interface Room { matchId: string; roomCode: string; entryFee: number; playerCount: 2 | 4; players: QueueItem[]; creatorId: string; started: boolean; }
interface LudoInvite { id: string; matchId: string; roomCode: string; fromUserId: string; toUserId: string; createdAt: string; expiresAt: string; }

@Injectable()
export class LudoService implements OnModuleDestroy {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly rooms = new Map<string, Room>();
  private readonly states = new Map<string, LudoState>();
  // One action at a time per match: a player's tap, the AI's move and the tick loop must never interleave.
  private readonly matchChains = new Map<string, Promise<unknown>>();
  // Redis is preferred for multi-instance coordination, but Ludo must remain usable if Redis is temporarily full/unavailable.
  // These maps are a bounded fallback for the active API instance; durable match state remains in Postgres.
  private readonly localTickets = new Map<string, QuickTicket>();
  private readonly localInvites = new Map<string, LudoInvite>();
  private readonly localInviteIds = new Map<string, Set<string>>();
  private readonly localQuickLocks = new Set<string>();
  private readonly redis: IORedis;

  constructor(private readonly prisma: PrismaService, private readonly wallet: WalletService, private readonly rounds: RoundService, private readonly config: ConfigService) {
    this.redis = new IORedis(this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on('error', () => undefined);
  }

  async onModuleDestroy() { await this.redis.quit().catch(() => undefined); }

  private queueKey(entryFee: number, playerCount: 2 | 4) { return `${entryFee}:${playerCount}`; }

  async ensureDefinition() {
    return this.prisma.gameDefinition.upsert({
      where: { code: 'LUDO' },
      update: {},
      create: {
        code: 'LUDO', name: 'Ludo', status: 'DISABLED', version: 1,
        rulesJson: { minEntry: 100, maxEntry: 500000, turnSeconds: 20, reconnectSeconds: 120, prizeFirstPercent: 70, prizeSecondPercent: 30, botFillSeconds: DEFAULT_BOT_FILL_SECONDS },
      },
    });
  }

  async quickMatch(userId: string, displayName: string, entryFee: number, playerCount: 2 | 4, countryCode = 'NG') {
    const game = await this.ensureDefinition();
    await this.rounds.assertGameAvailable('LUDO', countryCode);
    if (playerCount !== 2 && playerCount !== 4) throw new BadRequestException('Invalid Ludo player count');
    const rules = (game.rulesJson ?? {}) as any;
    if (!Number.isInteger(entryFee) || entryFee < Number(rules.minEntry ?? 100) || entryFee > Number(rules.maxEntry ?? 500000)) throw new BadRequestException('Invalid Ludo entry amount');
    await this.requireBalance(userId, entryFee);

    const existingTicket = await this.getUserQuickTicket(userId);
    if (existingTicket?.status === 'WAITING') return this.ticketResponse(existingTicket);
    if (existingTicket?.status === 'STARTED' && existingTicket.matchId) {
      // Resume only a match that is still being played; a finished match must not block a new Quick Match.
      const live = await this.getState(existingTicket.matchId).catch(() => null) as LudoState | null;
      if (live?.status === 'ACTIVE') return this.ticketResponse({ ...existingTicket, state: live });
    }

    const lockKey = `ludo:quick-lock:${this.queueKey(entryFee, playerCount)}`;
    const lockToken = uuid();
    let redisLock = false;
    let localLock = false;
    try {
      const locked = await this.redis.set(lockKey, lockToken, 'PX', 4000, 'NX');
      if (!locked) throw new BadRequestException('Quick Match is busy. Please try again.');
      redisLock = true;
    } catch (error) {
      // Do not turn Redis OOM/unavailable into a misleading "busy" error.
      if (this.localQuickLocks.has(lockKey)) throw new BadRequestException('Quick Match is busy. Please try again.');
      this.localQuickLocks.add(lockKey);
      localLock = true;
    }
    try {
      const ticket = uuid();
      const item: QueueItem = { userId, displayName, entryFee, playerCount, ticket };
      const key = this.queueKey(entryFee, playerCount);
      // Searches whose app went away (killed, no signal) must not count as players or fill a room.
      const queue = await this.pruneStale(await this.readQueue(key));
      const filtered = queue.filter(x => x.userId !== userId);
      filtered.push(item);
      const waiting: QuickTicket = { ticket, userId, entryFee, playerCount, status: 'WAITING', players: Math.min(filtered.length, playerCount), createdAt: new Date().toISOString(), lastSeenAt: Date.now() };
      await this.writeTicket(waiting);
      await this.redis.set(`ludo:quick-user:${userId}`, ticket, 'EX', 900).catch(() => undefined); // Redis being down must not stop Quick Match
      if (filtered.length < playerCount) {
        await this.writeQueue(key, filtered);
        return this.ticketResponse(waiting);
      }
      const players = filtered.slice(0, playerCount);
      await this.writeQueue(key, filtered.slice(playerCount));
      const result = await this.startMatch(players, undefined);
      const started = result as any;
      for (const player of players) {
        if (!player.ticket) continue;
        const t: QuickTicket = { ticket: player.ticket, userId: player.userId, entryFee, playerCount, status: 'STARTED', matchId: started.matchId, roomCode: started.roomCode, players: playerCount, state: started.state, createdAt: waiting.createdAt };
        await this.writeTicket(t);
        await this.redis.set(`ludo:quick-user:${player.userId}`, player.ticket, 'EX', 3600).catch(() => undefined);
      }
      return result;
    } finally {
      if (redisLock) {
        const current = await this.redis.get(lockKey).catch(() => null);
        if (current === lockToken) await this.redis.del(lockKey).catch(() => undefined);
      }
      if (localLock) this.localQuickLocks.delete(lockKey);
    }
  }

  async quickMatchStatus(userId: string, ticket: string) {
    const raw = await this.redis.get(`ludo:quick-ticket:${ticket}`).catch(() => null);
    const data = raw ? JSON.parse(raw) as QuickTicket : this.localTickets.get(ticket);
    if (!data) throw new NotFoundException('Quick Match ticket expired');
    if (data.userId !== userId) throw new BadRequestException('Invalid Quick Match ticket');
    if (data.status === 'WAITING') {
      // Polling doubles as "I am still here". Nobody found after the wait? Fill the seats with bots.
      data.lastSeenAt = Date.now();
      // "2/4 players found" reflects the people searching right now, not the count at the time this search began.
      const searching = (await this.readQueue(this.queueKey(data.entryFee, data.playerCount))).length;
      data.players = Math.max(1, Math.min(searching, data.playerCount));
      await this.writeTicket(data);
      return this.startBotMatch(userId, ticket, false);
    }
    return this.ticketResponse(data);
  }

  private async readTicket(ticket: string): Promise<QuickTicket | undefined> {
    const raw = await this.redis.get(`ludo:quick-ticket:${ticket}`).catch(() => null);
    return raw ? JSON.parse(raw) as QuickTicket : this.localTickets.get(ticket);
  }

  private async botFillSeconds(): Promise<number> {
    const game = await this.prisma.gameDefinition.findUnique({ where: { code: 'LUDO' }, select: { rulesJson: true } });
    const value = Number(((game?.rulesJson ?? {}) as any).botFillSeconds ?? DEFAULT_BOT_FILL_SECONDS);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BOT_FILL_SECONDS;
  }

  private async botMatchesPaid(): Promise<boolean> {
    const game = await this.prisma.gameDefinition.findUnique({ where: { code: 'LUDO' }, select: { rulesJson: true } });
    const v = ((game?.rulesJson ?? {}) as any).botMatchPaid;
    return !(v === 0 || v === false); // paid unless an admin switches it off
  }

  // Drops searches that are gone, cancelled, already started or abandoned.
  private async pruneStale(queue: QueueItem[]): Promise<QueueItem[]> {
    const now = Date.now();
    const keep: QueueItem[] = [];
    for (const item of queue) {
      if (!item.ticket) { keep.push(item); continue; }
      const t = await this.readTicket(item.ticket);
      if (!t || t.status !== 'WAITING') continue;
      if (now - (t.lastSeenAt ?? Date.parse(t.createdAt)) > STALE_TICKET_MS) {
        t.status = 'CANCELLED';
        await this.writeTicket(t);
        continue;
      }
      keep.push(item);
    }
    return keep;
  }

  private async withQuickLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    const lockKey = `ludo:quick-lock:${key}`;
    const token = uuid();
    let redisLock = false;
    let localLock = false;
    try {
      const locked = await this.redis.set(lockKey, token, 'PX', 4000, 'NX');
      if (!locked) return null;
      redisLock = true;
    } catch {
      if (this.localQuickLocks.has(lockKey)) return null;
      this.localQuickLocks.add(lockKey);
      localLock = true;
    }
    try {
      return await fn();
    } finally {
      if (redisLock && (await this.redis.get(lockKey).catch(() => null)) === token) await this.redis.del(lockKey).catch(() => undefined);
      if (localLock) this.localQuickLocks.delete(lockKey);
    }
  }

  /**
   * Starts a match against AI: the people currently searching at these settings plus AI players for the
   * empty seats. By default it is NOT free: every human pays the entry fee exactly like a normal match and
   * the prize pool is the normal one (the AI seats are funded by the house; `botPrizePercent` scales that pool
   * down for a house edge). Setting rulesJson.botMatchPaid to 0 turns these into free practice matches.
   * `force` is the "play with AI now" button; otherwise it only happens once the wait is over.
   */
  async startBotMatch(userId: string, ticketId: string, force = false) {
    const data = await this.readTicket(ticketId);
    if (!data) throw new NotFoundException('Quick Match ticket expired');
    if (data.userId !== userId) throw new BadRequestException('Invalid Quick Match ticket');
    if (data.status !== 'WAITING') return this.ticketResponse(data);
    const waitSeconds = await this.botFillSeconds();
    if (waitSeconds <= 0) {
      if (force) throw new BadRequestException('AI matches are switched off');
      return this.ticketResponse(data);
    }
    if (!force && Date.now() - Date.parse(data.createdAt) < waitSeconds * 1000) return this.ticketResponse(data);
    const paid = await this.botMatchesPaid();

    const key = this.queueKey(data.entryFee, data.playerCount);
    const result = await this.withQuickLock(key, async () => {
      const current = await this.readTicket(ticketId);
      if (!current || current.status !== 'WAITING') return current ? this.ticketResponse(current) : null;
      const queue = await this.pruneStale(await this.readQueue(key));
      let humans = queue.filter(x => x.ticket).slice(0, data.playerCount);
      if (!humans.some(h => h.userId === userId)) return this.ticketResponse(current); // matched or removed in the meantime

      // A paid match only starts with people who can still afford it; the rest leave the search.
      let broke: QueueItem[] = [];
      if (paid) {
        const funded: QueueItem[] = [];
        for (const h of humans) {
          const balance = await this.wallet.getBalance(h.userId, WalletType.COIN).catch(() => 0n);
          if (balance >= BigInt(data.entryFee)) funded.push(h); else broke.push(h);
        }
        humans = funded;
        for (const b of broke) {
          const t = b.userId === userId ? current : await this.readTicket(b.ticket!);
          if (t) { t.status = 'CANCELLED'; t.players = 0; await this.writeTicket(t); }
        }
      }
      await this.writeQueue(key, queue.filter(x => !humans.includes(x) && !broke.includes(x)));
      if (!humans.some(h => h.userId === userId)) throw new BadRequestException('Insufficient balance');

      const bots: QueueItem[] = Array.from({ length: data.playerCount - humans.length }, (_, i) => ({
        userId: `bot:${uuid()}`, displayName: `${BOT_NAMES[(i + Math.floor(Math.random() * BOT_NAMES.length)) % BOT_NAMES.length]} (AI)`,
        entryFee: paid ? data.entryFee : 0, playerCount: data.playerCount, synthetic: true,
      }));
      const started = await this.startMatch([...humans, ...bots], undefined, { practice: !paid });
      let mine: QuickTicket = current;
      for (const human of humans) {
        const t = (human.userId === userId ? current : await this.readTicket(human.ticket!)) ?? current;
        const done: QuickTicket = { ...t, status: 'STARTED', matchId: started.matchId, roomCode: started.roomCode, players: data.playerCount, state: started.state };
        await this.writeTicket(done);
        if (human.userId === userId) mine = done;
      }
      return this.ticketResponse(mine);
    });
    return result ?? this.ticketResponse(data); // lock busy: still waiting, the next check retries
  }

  // How many people are searching right now, per entry amount and size. Lets the lobby show
  // where a match will start immediately.
  async quickMatchLobby() {
    const keys = new Set<string>(this.queues.keys());
    try { for (const k of await this.redis.keys('ludo:queue:*')) keys.add(k.replace('ludo:queue:', '')); } catch { /* local queues only */ }
    const rows: Array<{ entryFee: number; playerCount: number; waiting: number }> = [];
    for (const key of keys) {
      const [fee, count] = key.split(':').map(Number);
      if (!Number.isFinite(fee) || !Number.isFinite(count)) continue;
      const waiting = (await this.pruneStale(await this.readQueue(key))).length;
      if (waiting > 0) rows.push({ entryFee: fee, playerCount: count, waiting });
    }
    return rows;
  }

  async cancelQuickMatch(userId: string, ticket: string) {
    const raw = await this.redis.get(`ludo:quick-ticket:${ticket}`).catch(() => null);
    const data = raw ? JSON.parse(raw) as QuickTicket : this.localTickets.get(ticket);
    if (!data) return { status: 'CANCELLED', ticket };
    if (data.userId !== userId) throw new BadRequestException('Invalid Quick Match ticket');
    if (data.status !== 'WAITING') return this.ticketResponse(data);
    const key = this.queueKey(data.entryFee, data.playerCount);
    const queue = await this.readQueue(key);
    await this.writeQueue(key, queue.filter(item => item.ticket !== ticket && item.userId !== userId));
    data.status = 'CANCELLED'; data.players = 0;
    await this.writeTicket(data);
    await this.redis.del(`ludo:quick-user:${userId}`).catch(() => undefined);
    return this.ticketResponse(data);
  }

  private async getUserQuickTicket(userId: string): Promise<QuickTicket | null> {
    const ticket = await this.redis.get(`ludo:quick-user:${userId}`).catch(() => null);
    if (ticket) {
      const raw = await this.redis.get(`ludo:quick-ticket:${ticket}`).catch(() => null);
      if (raw) return JSON.parse(raw) as QuickTicket;
    }
    for (const data of this.localTickets.values()) if (data.userId === userId && data.status !== 'CANCELLED') return data;
    return null;
  }

  private async writeTicket(ticket: QuickTicket) {
    const ttl = ticket.status === 'WAITING' ? 900 : 3600;
    this.localTickets.set(ticket.ticket, ticket);
    try { await this.redis.set(`ludo:quick-ticket:${ticket.ticket}`, JSON.stringify(ticket), 'EX', ttl); } catch {}
  }

  private ticketResponse(ticket: QuickTicket) {
    return { status: ticket.status, ticket: ticket.ticket, matchId: ticket.matchId, roomCode: ticket.roomCode, players: ticket.players ?? 0, playerCount: ticket.playerCount, state: ticket.state };
  }

  async createRoom(userId: string, displayName: string, entryFee: number, playerCount: 2 | 4, countryCode = 'NG') {
    const game = await this.ensureDefinition();
    await this.rounds.assertGameAvailable('LUDO', countryCode);
    if (playerCount !== 2 && playerCount !== 4) throw new BadRequestException('Invalid Ludo player count');
    const rules = (game.rulesJson ?? {}) as any;
    if (!Number.isInteger(entryFee) || entryFee < Number(rules.minEntry ?? 100) || entryFee > Number(rules.maxEntry ?? 500000)) throw new BadRequestException('Invalid Ludo entry amount');
    await this.requireBalance(userId, entryFee);
    const matchId = uuid();
    const roomCode = this.makeRoomCode();
    const room: Room = { matchId, roomCode, entryFee, playerCount, players: [{ userId, displayName, entryFee, playerCount }], creatorId: userId, started: false };
    this.rooms.set(roomCode, room);
    await this.writeRoom(room);
    return { status: 'WAITING', matchId, roomCode, players: 1, playerCount };
  }

  async roomStatus(userId: string, roomCode: string) {
    const room = this.rooms.get(roomCode.toUpperCase()) ?? await this.readRoom(roomCode.toUpperCase());
    if (!room) throw new NotFoundException('Ludo room not found');
    if (!room.players.some(p => p.userId === userId)) throw new BadRequestException('You are not in this Ludo room');
    if (room.started) {
      return { status: 'STARTED', matchId: room.matchId, roomCode: room.roomCode, players: room.players.length, playerCount: room.playerCount, state: await this.getState(room.matchId) };
    }
    return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: room.players.length, playerCount: room.playerCount };
  }

  async joinRoom(userId: string, displayName: string, roomCode: string, countryCode = 'NG') {
    const normalizedCode = roomCode.toUpperCase();
    const room = this.rooms.get(normalizedCode) ?? await this.readRoom(normalizedCode);
    if (!room) throw new NotFoundException('Ludo room not found');
    await this.rounds.assertGameAvailable('LUDO', countryCode);
    if (room.started) throw new BadRequestException('Match already started');
    if (room.players.some(p => p.userId === userId)) return this.startIfReady(room);
    if (room.players.length >= room.playerCount) throw new BadRequestException('Room is full');
    await this.requireBalance(userId, room.entryFee);
    room.players.push({ userId, displayName, entryFee: room.entryFee, playerCount: room.playerCount });
    this.rooms.set(room.roomCode, room);
    await this.writeRoom(room);
    return this.startIfReady(room);
  }

  private async startIfReady(room: Room) {
    if (room.players.length < room.playerCount) return { status: 'WAITING', matchId: room.matchId, roomCode: room.roomCode, players: room.players.length, playerCount: room.playerCount };
    room.started = true;
    this.rooms.set(room.roomCode, room);
    await this.writeRoom(room);
    return this.startMatch(room.players, room);
  }

  private async startMatch(players: QueueItem[], room?: Room, opts: { practice?: boolean } = {}) {
    const practice = opts.practice === true;
    const matchId = room?.matchId ?? uuid();
    const roomCode = room?.roomCode ?? this.makeRoomCode();
    const entryFee = practice ? 0 : players[0].entryFee;
    const playerCount = players.length as 2 | 4;
    const game = await this.prisma.gameDefinition.findUnique({ where: { code: 'LUDO' }, select: { rulesJson: true } });
    const rules = (game?.rulesJson ?? {}) as any;
    // AI seats put nothing in; the house covers that share of the pool, scaled by botPrizePercent (default 100).
    const hasAi = players.some(p => p.synthetic);
    const aiScale = hasAi ? Math.min(100, Math.max(0, Number(rules.botPrizePercent ?? 100))) / 100 : 1;
    const totalPool = Math.floor(entryFee * playerCount * aiScale); // practice: 0
    // Two players: the winner takes the pool (there is no second place). Four players: 1st/2nd split.
    const firstPct = playerCount === 2 ? Number(rules.prizeFirstPercent2p ?? 100) : Number(rules.prizeFirstPercent ?? 70);
    const prizeFirst = Math.floor(totalPool * (firstPct / 100));
    const prizeSecond = totalPool - prizeFirst;
    const now = new Date();

    // Debit all entries atomically with their durable GameEntry records.
    const round = await this.prisma.$transaction(async tx => {
      const created = await tx.gameRound.create({ data: { id: matchId, gameCode: 'LUDO', rulesVersion: 1, entryPrice: entryFee, openAt: now, lockAt: new Date(now.getTime() + 10_000), status: 'OPEN', hiddenState: {} as any } });
      for (const p of practice ? [] : players.filter(x => !x.synthetic)) {
        await this.wallet.debit({ userId: p.userId, walletType: WalletType.COIN, amount: BigInt(entryFee), ledgerType: LedgerEntryType.GAME_ENTRY, reference: created.id, idempotencyKey: `ludo_entry:${created.id}:${p.userId}` }, tx);
        await tx.gameEntry.create({ data: { roundId: created.id, userId: p.userId, selection: { roomCode }, coinAmount: entryFee, idempotencyKey: `ludo_entry_record:${created.id}:${p.userId}` } });
      }
      return created;
    });

    const turnSeconds = Math.max(5, Number(rules.turnSeconds ?? TURN_MS / 1000));
    const state = createLudoState({ matchId, roomCode, entryFee, playerCount, players, prizeFirst, prizeSecond, turnSeconds, practice });
    this.states.set(matchId, state);
    await this.persistState(state);
    await this.redis.del(this.roomKey(roomCode)).catch(() => undefined);
    return { status: 'STARTED', matchId, roomCode, state };
  }

  async getState(matchId: string) {
    const local = this.states.get(matchId);
    if (local) return this.publicState(local);
    const round = await this.prisma.gameRound.findUnique({ where: { id: matchId } });
    if (!round || round.gameCode !== 'LUDO') throw new NotFoundException('Ludo match not found');
    if (round.hiddenState && typeof round.hiddenState === 'object') return round.hiddenState;
    throw new NotFoundException('Ludo state unavailable');
  }

  private withMatch<T>(matchId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.matchChains.get(matchId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.matchChains.set(matchId, tail);
    void tail.then(() => { if (this.matchChains.get(matchId) === tail) this.matchChains.delete(matchId); });
    return run;
  }

  private assertActive(state: LudoState) { if (state.status !== 'ACTIVE') throw new BadRequestException('This match is over'); }

  /** What happens right after a roll: a cancelled third six or an unplayable roll ends the turn. */
  private afterRoll(state: LudoState, player: LudoPlayerState, result: { dice: number; threeSixPenalty: boolean; legalMoves: number[] }) {
    if (result.threeSixPenalty) {
      player.consecutiveSixes = 0;
      advanceTurn(state, player.seat, false);
    } else if (result.legalMoves.length === 0) {
      advanceTurn(state, player.seat, result.dice === 6);
    }
  }

  /** Plays one token for `player`, then either ends the match or passes the turn. Shared by people and the AI. */
  private async playToken(state: LudoState, player: LudoPlayerState, tokenIndex: number, dice: number) {
    applyMove(state, player.seat, tokenIndex, dice);
    if (recordFinish(state, player)) { await this.finishMatch(state); return; }
    advanceTurn(state, player.seat, dice === 6);
  }

  async roll(userId: string, matchId: string) {
    return this.withMatch(matchId, async () => {
      const state = await this.requireState(matchId);
      this.assertActive(state);
      const player = this.playerFor(state, userId);
      if (state.currentSeat !== player.seat) throw new BadRequestException('Not your turn');
      if (state.lastRoll != null) throw new BadRequestException('You already rolled. Move a token.');
      giveControlBack(state, player); // rolling yourself means you are back
      this.afterRoll(state, player, rollForTurn(state, player.seat));
      await this.persistState(state);
      return this.publicState(state);
    });
  }

  async move(userId: string, matchId: string, tokenIndex: number) {
    return this.withMatch(matchId, async () => {
      const state = await this.requireState(matchId);
      this.assertActive(state);
      const player = this.playerFor(state, userId);
      if (state.currentSeat !== player.seat) throw new BadRequestException('Not your turn');
      if (state.lastRoll == null) throw new BadRequestException('Roll the dice first');
      const dice = state.lastRoll;
      if (!legalMoves(state, player.seat, dice).includes(tokenIndex)) throw new BadRequestException('Illegal token');
      giveControlBack(state, player);
      await this.playToken(state, player, tokenIndex, dice);
      await this.persistState(state);
      return this.publicState(state);
    });
  }

  /** The player is (back) in the match: the AI hands the seat back. Also used by the explicit "take back control" button. */
  async reconnect(userId: string, matchId: string) {
    return this.withMatch(matchId, async () => {
      const state = await this.requireState(matchId);
      const player = this.playerFor(state, userId);
      giveControlBack(state, player);
      await this.persistState(state);
      return this.publicState(state);
    });
  }

  async resume(userId: string, matchId: string) { return this.reconnect(userId, matchId); }

  /** The player's connection dropped. The AI covers their turns (after a short grace) until they are back. */
  async disconnect(userId: string, matchId: string) {
    return this.withMatch(matchId, async () => {
      const state = this.states.get(matchId);
      if (!state || state.status !== 'ACTIVE') return undefined;
      const player = state.players.find(p => p.userId === userId);
      if (!player || player.synthetic) return undefined;
      player.connected = false;
      await this.persistState(state);
      return this.publicState(state);
    });
  }

  async tickActiveMatches() {
    const rounds = await this.prisma.gameRound.findMany({ where: { gameCode: 'LUDO', status: { in: ['OPEN', 'LOCKED', 'RESOLVING'] } }, select: { id: true } });
    const states: LudoState[] = [];
    for (const row of rounds) {
      try {
        // Redis only de-duplicates work between API instances. If it is down, the per-match lock still keeps this instance safe.
        let acquired = true;
        try { acquired = !!(await this.redis.set(`ludo:tick-lock:${row.id}`, uuid(), 'PX', 2500, 'NX')); } catch { acquired = true; }
        if (!acquired) continue;
        const before = this.states.get(row.id);
        const seenBefore = before ? `${before.actionAt}:${before.status}` : '';
        const state = await this.tick(row.id);
        const after = `${state.actionAt}:${state.status}`;
        if (after !== seenBefore) states.push(state); // only broadcast when the AI actually did something
      } catch { /* one match must never stop the loop for others */ }
    }
    return states;
  }

  /** A player asking the server to check the clock (fallback for clients without a socket). */
  async tickAs(userId: string, matchId: string) {
    const state = await this.requireState(matchId);
    this.playerFor(state, userId);
    return this.tick(matchId);
  }

  /**
   * The AI runs the seat of a bot, or of a human who ran out of time / lost their connection. It plays like a
   * person: roll, a short pause, then move. Once it has taken over a human it keeps playing every one of that
   * human's turns at bot speed, so an absent player never stalls the table, until the human comes back.
   */
  async tick(matchId: string) {
    return this.withMatch(matchId, async () => {
      const state = await this.requireState(matchId);
      if (state.status !== 'ACTIVE') return this.publicState(state);
      const player = state.players[state.currentSeat];
      if (!player) return this.publicState(state);
      if (Date.now() < serverActsAt(state, player)) return this.publicState(state);

      if (!isAiControlled(player)) {
        // A person's clock ran out (or they dropped): the AI takes the seat for them.
        player.missedTurns = (player.missedTurns ?? 0) + 1;
        if (!player.connected || player.missedTurns >= AUTOPILOT_AFTER_MISSED_TURNS) handToAi(player);
      }

      if (state.lastRoll == null) {
        this.afterRoll(state, player, rollForTurn(state, player.seat));
      } else {
        // Already rolled (by the person or a moment ago by the AI): play that roll instead of rolling again.
        const dice = state.lastRoll;
        const moves = legalMoves(state, player.seat, dice);
        if (moves.length === 0) advanceTurn(state, player.seat, false);
        else await this.playToken(state, player, pickBotMove(state, player.seat, dice, moves), dice);
      }
      await this.persistState(state);
      return this.publicState(state);
    });
  }

  private async finishMatch(state: LudoState) {
    if (state.status === 'FINISHED') return;
    state.status = 'FINISHED';
    // Keep the result around briefly for late polls, then free the memory.
    const evict = setTimeout(() => this.states.delete(state.matchId), 10 * 60_000);
    evict.unref?.();
    const round = await this.prisma.gameRound.findUnique({ where: { id: state.matchId } });
    if (!round || round.status === 'SETTLED') return;
    if (state.practice) {
      // Nothing was staked, so there is nothing to pay. Just close the match.
      await this.prisma.gameRound.update({ where: { id: state.matchId }, data: { status: 'SETTLED', result: { winnerUserId: state.winnerUserId, practice: true } as any, settledAt: new Date(), hiddenState: state as any } });
      return;
    }
    const payouts = new Map<string, number>();
    if (state.winnerUserId) payouts.set(state.winnerUserId, state.prizeFirst);
    if (state.secondPlaceUserId) payouts.set(state.secondPlaceUserId, state.prizeSecond);
    await this.prisma.$transaction(async tx => {
      for (const [userId, amount] of payouts) {
        const entry = await tx.gameEntry.findFirst({ where: { roundId: state.matchId, userId, status: 'PLACED' } });
        if (!entry) continue;
        if (amount > 0) {
          await this.wallet.credit({ userId, walletType: WalletType.COIN, amount: BigInt(amount), ledgerType: LedgerEntryType.GAME_REWARD, reference: entry.id, idempotencyKey: `ludo_reward:${entry.id}` }, tx);
        }
        await tx.gameEntry.update({ where: { id: entry.id }, data: { status: 'WON', rewardAmount: amount } });
      }
      await tx.gameEntry.updateMany({ where: { roundId: state.matchId, status: 'PLACED' }, data: { status: 'LOST', rewardAmount: 0 } });
      await tx.gameRound.update({ where: { id: state.matchId }, data: { status: 'SETTLED', result: { winnerUserId: state.winnerUserId, secondPlaceUserId: state.secondPlaceUserId, prizeFirst: state.prizeFirst, prizeSecond: state.prizeSecond }, settledAt: new Date(), hiddenState: state as any } });
    });
  }

  private queueRedisKey(key: string) { return `ludo:queue:${key}`; }
  private roomKey(code: string) { return `ludo:room:${code.toUpperCase()}`; }
  private async readQueue(key: string): Promise<QueueItem[]> {
    try { const raw = await this.redis.get(this.queueRedisKey(key)); if (raw) return JSON.parse(raw); } catch {}
    return this.queues.get(key) ?? [];
  }
  private async writeQueue(key: string, queue: QueueItem[]) {
    this.queues.set(key, queue);
    try { if (queue.length) await this.redis.set(this.queueRedisKey(key), JSON.stringify(queue), 'EX', 600); else await this.redis.del(this.queueRedisKey(key)); } catch {}
  }
  private async writeRoom(room: Room) { try { await this.redis.set(this.roomKey(room.roomCode), JSON.stringify(room), 'EX', 3600); } catch {} }
  private async findRoomByMatchId(matchId: string): Promise<Room | undefined> {
    for (const room of this.rooms.values()) if (room.matchId === matchId) return room;
    const key = 'ludo:room:*';
    try {
      const keys = await this.redis.keys(key);
      for (const redisKey of keys) {
        const raw = await this.redis.get(redisKey);
        if (!raw) continue;
        const room = JSON.parse(raw) as Room;
        if (room.matchId === matchId) { this.rooms.set(room.roomCode, room); return room; }
      }
    } catch {}
    return undefined;
  }

  private async readRoom(code: string): Promise<Room | undefined> {
    try { const raw = await this.redis.get(this.roomKey(code)); if (!raw) return undefined; const room = JSON.parse(raw) as Room; this.rooms.set(code, room); return room; } catch { return undefined; }
  }

  async ludoCandidates(userId: string, category: 'friends' | 'agency', search?: string) {
    const needle = (search ?? '').trim();
    const base = needle ? { displayName: { contains: needle, mode: 'insensitive' as const } } : {};
    let userIds: string[] = [];
    if (category === 'friends') {
      const [following, followers] = await Promise.all([
        this.prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } }),
        this.prisma.follow.findMany({ where: { followingId: userId }, select: { followerId: true } }),
      ]);
      const followerSet = new Set(followers.map(r => r.followerId));
      userIds = following.map(r => r.followingId).filter(id => followerSet.has(id));
    } else {
      const membership = await this.prisma.agencyMembership.findFirst({ where: { creatorId: userId, status: 'ACTIVE' } });
      if (!membership) return [];
      const members = await this.prisma.agencyMembership.findMany({ where: { agencyId: membership.agencyId, status: 'ACTIVE', creatorId: { not: userId } }, select: { creatorId: true } });
      userIds = members.map(r => r.creatorId);
    }
    if (!userIds.length) return [];
    return this.prisma.user.findMany({ where: { id: { in: userIds }, ...base }, select: { id: true, displayName: true, avatarUrl: true }, orderBy: { displayName: 'asc' }, take: 100 });
  }

  async inviteToRoom(fromUserId: string, matchId: string, toUserId: string) {
    const room = [...this.rooms.values()].find(r => r.matchId === matchId) ?? await this.findRoomByMatchId(matchId);
    if (!room) throw new NotFoundException('Ludo room not found');
    if (room.creatorId !== fromUserId && !room.players.some(p => p.userId === fromUserId)) throw new BadRequestException('You are not in this Ludo room');
    if (room.started) throw new BadRequestException('Match already started');
    if (room.players.some(p => p.userId === toUserId)) throw new BadRequestException('Player is already in the room');
    if (room.players.length >= room.playerCount) throw new BadRequestException('Room is full');
    const invite: LudoInvite = { id: uuid(), matchId, roomCode: room.roomCode, fromUserId, toUserId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    this.localInvites.set(invite.id, invite);
    const ids = this.localInviteIds.get(toUserId) ?? new Set<string>(); ids.add(invite.id); this.localInviteIds.set(toUserId, ids);
    try {
      await this.redis.set(`ludo:invite:${invite.id}`, JSON.stringify(invite), 'EX', 600);
      await this.redis.sadd(`ludo:invites:${toUserId}`, invite.id);
      await this.redis.expire(`ludo:invites:${toUserId}`, 600);
    } catch {}
    return invite;
  }

  async acceptInvite(userId: string, inviteId: string, displayName: string, countryCode = 'NG') {
    const raw = await this.redis.get(`ludo:invite:${inviteId}`).catch(() => null);
    const invite = raw ? JSON.parse(raw) as LudoInvite : this.localInvites.get(inviteId);
    if (!invite) throw new NotFoundException('Ludo invitation expired');
    if (invite.toUserId !== userId) throw new BadRequestException('Invitation does not belong to you');
    const result = await this.joinRoom(userId, displayName, invite.roomCode, countryCode);
    this.localInvites.delete(inviteId); this.localInviteIds.get(userId)?.delete(inviteId);
    await this.redis.del(`ludo:invite:${inviteId}`).catch(() => undefined);
    await this.redis.srem(`ludo:invites:${userId}`, inviteId).catch(() => undefined);
    return { ...result, inviteId };
  }

  async declineInvite(userId: string, inviteId: string) {
    const raw = await this.redis.get(`ludo:invite:${inviteId}`).catch(() => null);
    const invite = raw ? JSON.parse(raw) as LudoInvite : this.localInvites.get(inviteId);
    if (!invite) return { ok: true };
    if (invite.toUserId !== userId) throw new BadRequestException('Invitation does not belong to you');
    this.localInvites.delete(inviteId); this.localInviteIds.get(userId)?.delete(inviteId);
    await this.redis.del(`ludo:invite:${inviteId}`).catch(() => undefined);
    await this.redis.srem(`ludo:invites:${userId}`, inviteId).catch(() => undefined);
    return { ok: true };
  }

  async listInvites(userId: string) {
    const ids = new Set(await this.redis.smembers(`ludo:invites:${userId}`).catch(() => [] as string[]));
    for (const id of (this.localInviteIds.get(userId) ?? new Set<string>())) ids.add(id);
    const invites: LudoInvite[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`ludo:invite:${id}`).catch(() => null);
      const invite = raw ? JSON.parse(raw) as LudoInvite : this.localInvites.get(id);
      if (invite) invites.push(invite);
    }
    return invites;
  }

  private async requireState(matchId: string) { const state = this.states.get(matchId); if (state) return state; const data = await this.getState(matchId); this.states.set(matchId, data as LudoState); return data as LudoState; }
  private playerFor(state: LudoState, userId: string) { const p = state.players.find(p => p.userId === userId); if (!p) throw new BadRequestException('You are not a player in this match'); return p; }
  private async requireBalance(userId: string, amount: number) { const balance = await this.wallet.getBalance(userId, WalletType.COIN); if (balance < BigInt(amount)) throw new BadRequestException('Insufficient balance'); }
  private async persistState(state: LudoState) { await this.prisma.gameRound.update({ where: { id: state.matchId }, data: { hiddenState: state as any } }); }
  // serverNow lets each phone correct for its own clock when drawing the turn countdown.
  private publicState(state: LudoState): LudoState { return { ...state, serverNow: Date.now() }; }
  private makeRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i += 1) code += alphabet[randomInt(0, alphabet.length)];
    return code;
  }
}
