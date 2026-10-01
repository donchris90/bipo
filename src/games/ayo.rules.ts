/**
 * Ayo — Rryda house rules (as played by the product owner):
 *
 *  - 12 pits, 48 seeds. Round 1: each player owns 6 pits of 4 seeds.
 *  - A move: pick one of YOUR pits that has seeds, sow one seed per pit counter-clockwise around
 *    the whole board.
 *  - Relay: if the last seed lands in a pit that already had seeds, pick them all up and keep
 *    sowing. The turn ends when the last seed lands in an EMPTY pit.
 *  - Packing while sowing: when a pit reaches exactly 4 in the middle of your move, those 4 go to
 *    the pit's OWNER — on your side you pack them, on your opponent's side THEY pack them.
 *  - Last seed: if your last seed makes a pit 4 (on either side) YOU pack it and your turn ends.
 *  - A player whose pits are all empty skips their turn.
 *  - When only the last 4 seeds remain on the board, they go to the player who received the 4
 *    before them (whether they packed it by sowing or it was packed for them on their side), and the round ends. (Also when the board is empty.)
 *  - Next round: each player fills pits with 4 seeds from what they packed — 28 seeds = 7 pits,
 *    the opponent then has 5. Totals are always multiples of 4. Rounds alternate who starts
 *    (A starts round 1, B round 2, A round 3, ...).
 *  - A player who starts a round with exactly ONE pit may quit (loses) or continue.
 *  - A player with NO pits loses automatically. The winner takes the pot.
 *
 * Safety limits (so the server can never freeze or a game run forever):
 *  - one move is capped at MAX_SOW_STEPS seeds sown;
 *  - a round is capped at MAX_ROUND_TURNS turns — then the remaining seeds go to the last packer;
 *  - a game is capped at MAX_ROUNDS rounds — then whoever owns more pits wins (equal = draw).
 */

export type AyoCaptureMode = 'FOUR' | 'TWO_THREE'; // kept for admin config compatibility; rules are always "pack 4"

export type AyoRoundResult = { round: number; packed: [number, number]; pits: [number, number]; finalFourTo: 0 | 1 | null };

/** Step-by-step record of a move so clients can replay it seed by seed. */
export type AyoMoveEvent =
  | { t: 'pick'; pit: number; count: number }   // seeds lifted from a pit (start or relay)
  | { t: 'drop'; pit: number }                  // one seed dropped into a pit
  | { t: 'pack'; pit: number; seat: 0 | 1 }     // a pit reached 4; `seat` is who receives it
  | { t: 'final'; seat: 0 | 1; seeds: number }  // last seeds of the round go to the previous packer
  | { t: 'round'; round: number };              // a new round was set up (board refilled)

/** Animation timing shared by server (turn timers) and client (replay). */
export const AYO_ANIM = { dropMs: 170, pickMs: 260, packMs: 480, finalMs: 900, roundMs: 4200, maxMoveMs: 16000 };

export function moveAnimationMs(events: AyoMoveEvent[]): number {
  const drops = events.filter(e => e.t === 'drop').length;
  const dropMs = drops > 0 ? Math.min(AYO_ANIM.dropMs, Math.floor(AYO_ANIM.maxMoveMs / drops)) : AYO_ANIM.dropMs;
  let ms = 0;
  for (const e of events) {
    if (e.t === 'drop') ms += dropMs;
    else if (e.t === 'pick') ms += AYO_ANIM.pickMs;
    else if (e.t === 'pack') ms += AYO_ANIM.packMs;
    else if (e.t === 'final') ms += AYO_ANIM.finalMs;
    else if (e.t === 'round') ms += AYO_ANIM.roundMs;
  }
  return ms + 300;
}

export type AyoState = {
  matchId: string;
  roomCode: string;
  entryFee: number;
  status: 'WAITING' | 'ACTIVE' | 'FINISHED' | 'CANCELLED';
  board: number[];
  /** Seeds packed in the CURRENT round, per seat. */
  captured: [number, number];
  /** Which seat owns each pit this round (length 12). */
  owners: (0 | 1)[];
  round: number;
  roundTurns: number;
  /** Seat that packed the most recent 4 this round (gets the final 4). */
  lastPacker: 0 | 1 | null;
  /** Seat that made the first move of the current round (rounds alternate). */
  roundStarter: 0 | 1;
  /** Admin-configurable game length cap (rules.maxRounds); defaults to MAX_ROUNDS. */
  maxRounds?: number;
  /** Set when a player starts a round with exactly one pit and must choose quit/continue. */
  decision: { seat: 0 | 1; expiresAt: string } | null;
  lastRound: AyoRoundResult | null;
  currentSeat: 0 | 1;
  players: { userId: string; displayName: string; seat: 0 | 1; connected: boolean }[];
  turnNumber: number;
  turnStartedAt: string;
  turnExpiresAt: string;
  turnSeconds: number;
  winnerUserId?: string;
  endReason?: 'NO_PITS' | 'QUIT' | 'MAX_ROUNDS' | 'DISCONNECT';
  lastMove?: {
    seat: 0 | 1; pit: number; captured: number; path: number[]; packedAt: number[];
    /** Board, owners and packed counts BEFORE the move, plus every step, for seed-by-seed replay. */
    before?: number[]; ownersBefore?: (0 | 1)[]; capturedBefore?: [number, number];
    events?: AyoMoveEvent[]; animMs?: number;
  } | null;
  serverNow: number;
  prizePool: number;
  prizePayout: number;
  disconnectedAt?: [number | null, number | null];
  reconnectGraceSeconds: number;
};

export const PITS = 12;
export const TOTAL_SEEDS = 48;
export const MAX_SOW_STEPS = 2000;
export const MAX_ROUND_TURNS = 400;
export const MAX_ROUNDS = 30;
export const DECISION_SECONDS = 30;

export function initialAyoBoard(): number[] {
  return Array(PITS).fill(4);
}

export function defaultOwners(): (0 | 1)[] {
  return Array.from({ length: PITS }, (_, i) => (i < 6 ? 0 : 1));
}

/** Seat 0 owns pits [0, k0); seat 1 owns the rest. Contiguous, so an extra pit sits next to your row. */
export function ownersForPits(seat0Pits: number): (0 | 1)[] {
  const k = Math.max(0, Math.min(PITS, seat0Pits));
  return Array.from({ length: PITS }, (_, i) => (i < k ? 0 : 1));
}

/** Fill in fields missing from states saved by older versions. */
export function normalizeAyoState<T extends Partial<AyoState>>(s: T): T & AyoState {
  const st: any = s;
  if (!Array.isArray(st.owners) || st.owners.length !== PITS) st.owners = defaultOwners();
  if (!Number.isInteger(st.round)) st.round = 1;
  if (!Number.isInteger(st.roundTurns)) st.roundTurns = 0;
  if (st.lastPacker !== 0 && st.lastPacker !== 1) st.lastPacker = null;
  if (st.decision === undefined) st.decision = null;
  if (st.lastRound === undefined) st.lastRound = null;
  if (st.roundStarter !== 0 && st.roundStarter !== 1) st.roundStarter = 0;
  return st;
}

export function legalPits(board: number[], seat: 0 | 1, owners: (0 | 1)[] = defaultOwners()): number[] {
  const out: number[] = [];
  for (let i = 0; i < PITS; i++) if (owners[i] === seat && board[i] > 0) out.push(i);
  return out;
}

export function pitCount(owners: (0 | 1)[], seat: 0 | 1) {
  return owners.filter(o => o === seat).length;
}

/** Pure sowing of one move. Never loops forever (MAX_SOW_STEPS). */
export function simulateSow(input: number[], pit: number, seat: 0 | 1 = 0, owners: (0 | 1)[] = defaultOwners()) {
  const board = input.slice();
  if (board.length !== PITS) throw new Error('Ayo board must have 12 pits');
  if (!Number.isInteger(pit) || pit < 0 || pit >= PITS || board[pit] <= 0) throw new Error('Choose one of your pits that has seeds');
  let hand = board[pit];
  board[pit] = 0;
  let cur = pit;
  let packed = 0; // seeds the SOWER received this move
  const packedBy: [number, number] = [0, 0];
  let lastReceiver: 0 | 1 | null = null;
  const path: number[] = [];
  const packedAt: number[] = [];
  const events: AyoMoveEvent[] = [{ t: 'pick', pit, count: hand }];
  let steps = 0;
  while (hand > 0) {
    cur = (cur + 1) % PITS;
    board[cur] += 1;
    hand -= 1;
    steps += 1;
    path.push(cur);
    events.push({ t: 'drop', pit: cur });
    if (board[cur] === 4) {
      // Last seed -> the sower takes it (even on the opponent's side). Mid-sow -> the pit's owner.
      const to: 0 | 1 = hand === 0 ? seat : owners[cur];
      board[cur] = 0;
      packedBy[to] += 4;
      if (to === seat) packed += 4;
      lastReceiver = to;
      packedAt.push(cur);
      events.push({ t: 'pack', pit: cur, seat: to });
      continue; // a packed last seed leaves an empty pit -> turn ends
    }
    if (hand === 0 && board[cur] > 1) {
      // last seed landed in a pit that already had seeds -> relay
      hand = board[cur];
      board[cur] = 0;
      events.push({ t: 'pick', pit: cur, count: hand });
    }
    if (steps >= MAX_SOW_STEPS && hand > 0) {
      board[cur] += hand; // safety stop: put the hand down, seeds are conserved
      hand = 0;
    }
  }
  return { board, packed, packedBy, lastReceiver, path, packedAt, events };
}

function boardTotal(board: number[]) {
  return board.reduce((a, b) => a + b, 0);
}

/** Sets up the next round from what each player packed. Returns the game result if it is over. */
function startNextRound(st: AyoState, now: number): AyoState {
  const packed = st.captured;
  const pits: [number, number] = [Math.floor(packed[0] / 4), Math.floor(packed[1] / 4)];
  st.lastRound = { round: st.round, packed: [packed[0], packed[1]], pits, finalFourTo: st.lastRound?.round === st.round ? st.lastRound.finalFourTo : null };

  if (pits[0] === 0 || pits[1] === 0) {
    st.status = 'FINISHED';
    st.endReason = 'NO_PITS';
    st.winnerUserId = st.players.find(p => p.seat === (pits[0] === 0 ? 1 : 0))?.userId;
    return st;
  }
  if (st.round >= Math.max(1, Math.min(MAX_ROUNDS, Number(st.maxRounds) || MAX_ROUNDS))) {
    st.status = 'FINISHED';
    st.endReason = 'MAX_ROUNDS';
    st.winnerUserId = pits[0] === pits[1] ? undefined : st.players.find(p => p.seat === (pits[0] > pits[1] ? 0 : 1))?.userId;
    return st;
  }

  st.round += 1;
  st.roundTurns = 0;
  st.owners = ownersForPits(pits[0]);
  st.board = initialAyoBoard();
  st.captured = [0, 0];
  st.lastPacker = null;
  // Rounds alternate who starts.
  st.roundStarter = st.roundStarter === 0 ? 1 : 0;
  st.currentSeat = st.roundStarter;
  const oneSeat: 0 | 1 | null = pits[0] === 1 ? 0 : pits[1] === 1 ? 1 : null;
  st.decision = oneSeat === null ? null : { seat: oneSeat, expiresAt: new Date(now + DECISION_SECONDS * 1000).toISOString() };
  return st;
}

function endRound(st: AyoState, now: number, reason: 'EMPTY' | 'FINAL_FOUR' | 'TURN_CAP', events: AyoMoveEvent[] = []) {
  const left = boardTotal(st.board);
  let finalFourTo: 0 | 1 | null = null;
  if (left > 0) {
    events.push({ t: 'final', seat: st.lastPacker ?? (st.currentSeat === 0 ? 1 : 0), seeds: left });
    // The last seeds go to whoever packed the 4 before them.
    const to: 0 | 1 = st.lastPacker ?? (st.currentSeat === 0 ? 1 : 0);
    st.captured[to] += left;
    finalFourTo = to;
    st.board = Array(PITS).fill(0);
  }
  st.lastRound = { round: st.round, packed: [st.captured[0], st.captured[1]], pits: [0, 0], finalFourTo };
  void reason;
  startNextRound(st, now);
  if (st.status === 'ACTIVE') events.push({ t: 'round', round: st.round });
  return st;
}

/**
 * Applies one move by the player whose turn it is and returns the NEW state (input untouched).
 * Handles packing, the final-four rule, skipping a player with no seeds, round changes and game end.
 */
export function applyAyoMove(input: AyoState, pit: number, now = Date.now()): { state: AyoState; packed: number; path: number[]; packedAt: number[]; roundEnded: boolean; animMs: number } {
  const st: AyoState = normalizeAyoState(JSON.parse(JSON.stringify(input)));
  if (st.status !== 'ACTIVE') throw new Error('Ayo match is not active');
  if (st.decision) throw new Error('Waiting for a player to choose quit or continue');
  const seat = st.currentSeat;
  if (st.owners[pit] !== seat) throw new Error('That pit is not yours');
  if (!legalPits(st.board, seat, st.owners).includes(pit)) throw new Error('Choose one of your pits that has seeds');

  const before = st.board.slice();
  const ownersBefore = st.owners.slice();
  const capturedBefore: [number, number] = [st.captured[0], st.captured[1]];
  const r = simulateSow(st.board, pit, seat, st.owners);
  const events = r.events;
  st.board = r.board;
  st.captured[0] += r.packedBy[0];
  st.captured[1] += r.packedBy[1];
  if (r.lastReceiver !== null) st.lastPacker = r.lastReceiver;
  st.roundTurns += 1;
  st.turnNumber += 1;

  const left = boardTotal(st.board);
  const roundBefore = st.round;
  if (left === 0) endRound(st, now, 'EMPTY', events);
  else if (left <= 4) endRound(st, now, 'FINAL_FOUR', events);
  else if (st.roundTurns >= MAX_ROUND_TURNS) endRound(st, now, 'TURN_CAP', events);
  else {
    const next: 0 | 1 = seat === 0 ? 1 : 0;
    // A player whose pits are all empty skips their turn.
    if (legalPits(st.board, next, st.owners).length > 0) st.currentSeat = next;
    else if (legalPits(st.board, seat, st.owners).length > 0) st.currentSeat = seat;
    else endRound(st, now, 'EMPTY', events);
  }
  const animMs = moveAnimationMs(events);
  st.lastMove = { seat, pit, captured: r.packed, path: r.path, packedAt: r.packedAt, before, ownersBefore, capturedBefore, events, animMs };
  return { state: st, packed: r.packed, path: r.path, packedAt: r.packedAt, roundEnded: st.round !== roundBefore || st.status !== 'ACTIVE', animMs };
}

/** A player with one pit chooses to quit (they lose) or continue. */
export function applyAyoDecision(input: AyoState, seat: 0 | 1, quit: boolean): AyoState {
  const st: AyoState = normalizeAyoState(JSON.parse(JSON.stringify(input)));
  if (!st.decision || st.decision.seat !== seat) throw new Error('There is no decision for you to make');
  st.decision = null;
  if (quit) {
    st.status = 'FINISHED';
    st.endReason = 'QUIT';
    st.winnerUserId = st.players.find(p => p.seat !== seat)?.userId;
  }
  return st;
}

/** Simple bot: prefer the move that packs the most seeds, with a bit of randomness. */
export function chooseBotPit(state: AyoState, rand: (n: number) => number): number | null {
  const st = normalizeAyoState(state);
  const pits = legalPits(st.board, st.currentSeat, st.owners);
  if (!pits.length) return null;
  const opp: 0 | 1 = st.currentSeat === 0 ? 1 : 0;
  // Net gain: what I pack minus what my sowing hands to my opponent.
  const scored = pits.map(p => { const r = simulateSow(st.board, p, st.currentSeat, st.owners); return { p, gain: r.packedBy[st.currentSeat] - r.packedBy[opp] }; });
  const best = Math.max(...scored.map(s => s.gain));
  const pool = rand(100) < 75 ? scored.filter(s => s.gain === best) : scored;
  return pool[rand(pool.length)].p;
}

export function createInitialAyoState(params: {
  matchId: string; roomCode: string; entryFee: number;
  players: { userId: string; displayName: string; seat: 0 | 1 }[];
  turnSeconds: number;
  serverNow?: number;
}): AyoState {
  const now = params.serverNow ?? Date.now();
  return {
    matchId: params.matchId, roomCode: params.roomCode, entryFee: params.entryFee,
    status: 'ACTIVE', board: initialAyoBoard(), captured: [0, 0],
    owners: defaultOwners(), round: 1, roundTurns: 0, lastPacker: null, roundStarter: 0, decision: null, lastRound: null,
    currentSeat: 0, players: params.players.map(p => ({ ...p, connected: true })),
    turnNumber: 1,
    turnStartedAt: new Date(now).toISOString(),
    turnExpiresAt: new Date(now + params.turnSeconds * 1000).toISOString(),
    turnSeconds: params.turnSeconds, lastMove: null, serverNow: now,
    prizePool: params.entryFee * params.players.length, prizePayout: 0,
    disconnectedAt: [null, null], reconnectGraceSeconds: 60,
  };
}
