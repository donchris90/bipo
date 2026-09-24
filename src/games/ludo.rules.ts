import { randomInt } from 'node:crypto';

export type LudoPlayerColor = 'RED' | 'GREEN' | 'YELLOW' | 'BLUE';
export type LudoStatus = 'WAITING' | 'ACTIVE' | 'FINISHED' | 'CANCELLED';

export interface LudoToken { progress: number; }
export interface LudoPlayerState {
  userId: string;
  displayName: string;
  color: LudoPlayerColor;
  seat: number;
  connected: boolean;
  bot: boolean;
  tokens: LudoToken[];
  consecutiveSixes: number;
  finishedAt?: string;
  /** A server-controlled bot seat (filled in by Quick Match when nobody else is found). */
  synthetic?: boolean;
  /**
   * The AI is playing this human's seat (they timed out or lost their connection). It plays whole turns
   * (roll AND move) at bot speed until the human acts again or reconnects, which hands control back.
   */
  autopilot?: boolean;
  /** Turns in a row the human let the AI play. Reset the moment they act. */
  missedTurns?: number;
  /** Last time the human did something (roll, move, join, resume). */
  lastActiveAt?: string;
}
/** The most recent dice roll. Unlike `lastRoll` it survives the turn passing, so every client can show what was rolled. */
export interface LudoLastDice {
  seat: number;
  value: number;
  /** Increments on every roll so clients can tell two identical rolls apart. */
  seq: number;
  /** True when the roll could not be played (no legal token, or a cancelled third six). */
  noMove: boolean;
  /** True when this roll was the cancelled third consecutive six. */
  penalty: boolean;
}
export interface LudoState {
  matchId: string;
  roomCode: string;
  playerCount: 2 | 4;
  entryFee: number;
  prizeFirst: number;
  prizeSecond: number;
  status: LudoStatus;
  /** Practice match against bots: no entry fee, no prize. */
  practice?: boolean;
  currentSeat: number;
  turnNumber: number;
  turnStartedAt: string;
  turnExpiresAt: string;
  turnSeconds: number;
  /** When the last roll/turn change happened; bots and autopilot "think" from here. */
  actionAt?: string;
  /** Server clock at the moment this state was sent (never stored). */
  serverNow?: number;
  lastRoll: number | null;
  lastDice?: LudoLastDice | null;
  lastMove: { userId: string; tokenIndex: number; from: number; to: number; capturedUserId?: string } | null;
  players: LudoPlayerState[];
  winnerUserId?: string;
  secondPlaceUserId?: string;
}

export const COLORS: LudoPlayerColor[] = ['RED', 'GREEN', 'YELLOW', 'BLUE'];
// Two players sit in OPPOSITE corners (RED and YELLOW), not side by side.
export const COLORS_2P: LudoPlayerColor[] = ['RED', 'YELLOW'];
export const BOT_THINK_MS = 1100;
export const TURN_MS = 20_000;
export const RECONNECT_GRACE_MS = 120_000;
/** A connected human who does nothing for a whole turn hands the seat to the AI after this many missed turns. */
export const AUTOPILOT_AFTER_MISSED_TURNS = 1;
/** A human whose connection dropped: the AI steps in this long after their turn starts (rides out a network blip). */
export const DISCONNECT_TAKEOVER_MS = 4_000;

/**
 * Token path (matches the physical board):
 *   -1        in the base (yard)
 *   0 … 50    on the shared 52-square ring, starting on the player's own start square.
 *             A token walks 51 ring squares and then turns into its home lane
 *             (it never steps on the square directly behind its own start square).
 *   51 … 55   the five coloured home-lane squares
 *   56        home (finished)
 */
export const TRACK_LAST = 50;
export const LANE_START = 51;
export const HOME_PROGRESS = 56;

// Eight classic-style safe squares. Start squares are safe too.
const SAFE_TRACK = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const START_OFFSETS = [0, 13, 26, 39];

export function createLudoState(params: {
  matchId: string;
  roomCode: string;
  entryFee: number;
  playerCount: 2 | 4;
  players: Array<{ userId: string; displayName: string; synthetic?: boolean }>;
  prizeFirst: number;
  prizeSecond: number;
  turnSeconds?: number;
  practice?: boolean;
}): LudoState {
  const now = Date.now();
  const turnSeconds = params.turnSeconds ?? TURN_MS / 1000;
  return {
    matchId: params.matchId,
    roomCode: params.roomCode,
    playerCount: params.playerCount,
    entryFee: params.entryFee,
    prizeFirst: params.prizeFirst,
    prizeSecond: params.prizeSecond,
    status: 'ACTIVE',
    practice: params.practice === true,
    currentSeat: 0,
    turnNumber: 1,
    turnStartedAt: new Date(now).toISOString(),
    turnExpiresAt: new Date(now + turnSeconds * 1000).toISOString(),
    turnSeconds,
    actionAt: new Date(now).toISOString(),
    lastRoll: null,
    lastDice: null,
    lastMove: null,
    players: params.players.map((p, seat) => ({
      userId: p.userId,
      displayName: p.displayName,
      color: (params.playerCount === 2 ? COLORS_2P : COLORS)[seat],
      seat,
      connected: true,
      bot: false,
      autopilot: false,
      missedTurns: 0,
      lastActiveAt: new Date(now).toISOString(),
      ...(p.synthetic ? { synthetic: true } : {}),
      tokens: [{ progress: -1 }, { progress: -1 }, { progress: -1 }, { progress: -1 }],
      consecutiveSixes: 0,
    })),
  };
}

export function globalTrackIndex(seat: number, progress: number): number | null {
  if (progress < 0 || progress > TRACK_LAST) return null;
  return (START_OFFSETS[seat] + progress) % 52;
}

/** Ring square of a token, from the player's COLOUR (where its start square is), or null off the ring. */
export function trackIndexFor(player: Pick<LudoPlayerState, 'color'>, progress: number): number | null {
  return globalTrackIndex(COLORS.indexOf(player.color), progress);
}

export function isSafeTrack(index: number): boolean { return SAFE_TRACK.has(index); }

export function legalMoves(state: LudoState, seat: number, dice: number): number[] {
  const player = state.players[seat];
  if (!player) return [];
  return player.tokens.flatMap((token, i) => {
    if (token.progress === HOME_PROGRESS) return [];
    if (token.progress === -1) return dice === 6 ? [i] : [];
    return token.progress + dice <= HOME_PROGRESS ? [i] : [];
  });
}

export function applyMove(state: LudoState, seat: number, tokenIndex: number, dice: number) {
  const player = state.players[seat];
  if (!player) throw new Error('Player not found');
  const legal = legalMoves(state, seat, dice);
  if (!legal.includes(tokenIndex)) throw new Error('Illegal token move');
  const token = player.tokens[tokenIndex];
  const from = token.progress;
  const to = from === -1 ? 0 : from + dice;
  token.progress = to;

  let capturedUserId: string | undefined;
  const landing = trackIndexFor(player, to);
  if (landing !== null && !isSafeTrack(landing)) {
    for (const opponent of state.players) {
      if (opponent.seat === seat) continue;
      for (const other of opponent.tokens) {
        if (trackIndexFor(opponent, other.progress) === landing) {
          other.progress = -1;
          capturedUserId = opponent.userId;
        }
      }
    }
  }

  state.lastMove = { userId: player.userId, tokenIndex, from, to, capturedUserId };
  return { from, to, capturedUserId };
}

export function playerFinished(player: LudoPlayerState): boolean {
  return player.tokens.every(t => t.progress === HOME_PROGRESS);
}

export function nextActiveSeat(state: LudoState, fromSeat: number): number {
  for (let step = 1; step <= state.players.length; step++) {
    const seat = (fromSeat + step) % state.players.length;
    const p = state.players[seat];
    if (p && !p.finishedAt) return seat;
  }
  return fromSeat;
}

export function advanceTurn(state: LudoState, seat: number, extraTurn: boolean) {
  const nextSeat = extraTurn && !state.players[seat].finishedAt ? seat : nextActiveSeat(state, seat);
  state.currentSeat = nextSeat;
  state.turnNumber += extraTurn ? 0 : 1;
  const now = Date.now();
  state.turnStartedAt = new Date(now).toISOString();
  state.turnExpiresAt = new Date(now + state.turnSeconds * 1000).toISOString();
  state.actionAt = state.turnStartedAt;
  state.lastRoll = null;
  state.players.forEach(p => { if (p.seat !== nextSeat) p.consecutiveSixes = 0; });
}

export function rollForTurn(state: LudoState, seat: number, rng?: number): { dice: number; threeSixPenalty: boolean; legalMoves: number[] } {
  if (state.status !== 'ACTIVE') throw new Error('Match is not active');
  if (seat !== state.currentSeat) throw new Error('Not your turn');
  const player = state.players[seat];
  if (!player) throw new Error('Player not found');
  const dice = rng == null ? randomInt(1, 7) : Math.max(1, Math.min(6, Math.floor(rng)));
  if (dice === 6) player.consecutiveSixes += 1; else player.consecutiveSixes = 0;
  const threeSixPenalty = player.consecutiveSixes >= 3;
  state.lastRoll = dice;
  state.actionAt = new Date().toISOString();
  const moves = threeSixPenalty ? [] : legalMoves(state, seat, dice);
  state.lastDice = { seat, value: dice, seq: (state.lastDice?.seq ?? 0) + 1, noMove: moves.length === 0, penalty: threeSixPenalty };
  return { dice, threeSixPenalty, legalMoves: moves };
}

/** Would moving this token capture an opponent? */
function capturesOpponent(state: LudoState, seat: number, to: number): boolean {
  const player = state.players[seat];
  const landing = trackIndexFor(player, to);
  if (landing === null || isSafeTrack(landing)) return false;
  return state.players.some(o => o.seat !== seat && o.tokens.some(t => trackIndexFor(o, t.progress) === landing));
}

/** Progress of the most advanced opponent token that sits on `landing` (0 when none). */
function capturedValue(state: LudoState, seat: number, to: number): number {
  const player = state.players[seat];
  const landing = trackIndexFor(player, to);
  if (landing === null || isSafeTrack(landing)) return 0;
  let best = 0;
  for (const o of state.players) {
    if (o.seat === seat) continue;
    for (const t of o.tokens) if (trackIndexFor(o, t.progress) === landing) best = Math.max(best, t.progress + 1);
  }
  return best;
}

/**
 * How many opponent tokens could land exactly on this square with one roll (1-6).
 * Safe squares, the home lane and the yard cannot be hit. An opponent token about to leave the
 * ring for its home lane cannot reach it either.
 */
export function threatCount(state: LudoState, seat: number, progress: number): number {
  const player = state.players[seat];
  const landing = trackIndexFor(player, progress);
  if (landing === null || isSafeTrack(landing)) return 0;
  let threats = 0;
  for (const o of state.players) {
    if (o.seat === seat) continue;
    for (const t of o.tokens) {
      const at = trackIndexFor(o, t.progress);
      if (at === null) continue;
      const dist = (landing - at + 52) % 52;
      if (dist >= 1 && dist <= 6 && t.progress + dist <= TRACK_LAST) threats += 1;
    }
  }
  return threats;
}

/**
 * The move the AI makes for a bot seat, or for a human who is away. It plays like a sensible
 * player rather than a coin flip: finish a token, capture (the further along the victim, the better),
 * leave the yard, step onto safe squares / into the home lane, run from danger, and avoid ending a
 * move where several opponents can hit it.
 */
export function pickBotMove(state: LudoState, seat: number, dice: number, legal: number[]): number {
  const player = state.players[seat];
  const outCount = player.tokens.filter(t => t.progress >= 0 && t.progress < HOME_PROGRESS).length;
  let best = legal[0];
  let bestScore = -Infinity;
  for (const i of legal) {
    const from = player.tokens[i].progress;
    const to = from === -1 ? 0 : from + dice;
    let score = to * 1.5;

    if (to === HOME_PROGRESS) score += 1000;

    const victim = capturedValue(state, seat, to);
    if (victim > 0) score += 600 + victim * 4;

    if (from === -1) score += outCount === 0 ? 400 : outCount === 1 ? 260 : 150;

    if (to >= LANE_START && from < LANE_START) score += 180; // safely into the home lane
    const landing = trackIndexFor(player, to);
    if (landing !== null && isSafeTrack(landing)) score += 90;

    // Danger: how exposed is the token where it ends up, compared with where it stands now?
    const value = 60 + to * 3;
    const dangerAfter = to === HOME_PROGRESS ? 0 : threatCount(state, seat, to);
    const dangerBefore = from === -1 ? 0 : threatCount(state, seat, from);
    score -= dangerAfter * value;
    score += dangerBefore * value * 0.9;

    // Do not walk a token off a safe square for nothing.
    const fromTrack = from >= 0 ? trackIndexFor(player, from) : null;
    if (fromTrack !== null && isSafeTrack(fromTrack) && !(landing !== null && isSafeTrack(landing)) && to < LANE_START) score -= 30;

    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/**
 * Records that `player` may have just finished. Returns true when the whole match is over.
 * Two players: the first to bring all four tokens home wins. Four players: the match ends once two have finished.
 */
export function recordFinish(state: LudoState, player: LudoPlayerState): boolean {
  if (playerFinished(player)) {
    if (!player.finishedAt) player.finishedAt = new Date().toISOString();
    if (!state.winnerUserId) state.winnerUserId = player.userId;
    else if (!state.secondPlaceUserId && state.playerCount === 4) state.secondPlaceUserId = player.userId;
  }
  const finishedCount = state.players.filter(p => p.finishedAt).length;
  const stillRacing = state.players.length - finishedCount;
  if (state.playerCount === 2) return finishedCount >= 1;
  if (finishedCount >= 2) return true;
  if (finishedCount >= 1 && stillRacing <= 1) {
    // Everyone else is out of the race: the last player takes second place.
    const last = state.players.find(p => !p.finishedAt);
    if (last && !state.secondPlaceUserId) state.secondPlaceUserId = last.userId;
    return true;
  }
  return false;
}

/** Is this seat currently played by the server (a bot seat, or a human the AI covers)? */
export function isAiControlled(player: LudoPlayerState): boolean {
  return !!player.synthetic || !!player.autopilot;
}

/** A human acted or came back: they play their own seat again. */
export function giveControlBack(state: LudoState, player: LudoPlayerState, now = Date.now()): boolean {
  const wasAi = !!player.autopilot;
  player.autopilot = false;
  player.bot = false;
  player.connected = true;
  player.missedTurns = 0;
  player.lastActiveAt = new Date(now).toISOString();
  // If it is their turn and the clock is nearly gone, give them a fair turn back.
  if (wasAi && state.status === 'ACTIVE' && state.currentSeat === player.seat) {
    state.turnExpiresAt = new Date(now + state.turnSeconds * 1000).toISOString();
  }
  return wasAi;
}

/** The AI takes over a human's seat. */
export function handToAi(player: LudoPlayerState) {
  player.autopilot = true;
  player.bot = true;
}

/**
 * When may the server act for the player whose turn it is? Returns the timestamp (ms) or null if the
 * server must not act for them. Bots and autopilot seats think briefly; a dropped connection gets a short
 * grace; everyone else gets the full turn timer.
 */
export function serverActsAt(state: LudoState, player: LudoPlayerState): number {
  const anchor = Math.max(Date.parse(state.turnStartedAt), Date.parse(state.actionAt ?? state.turnStartedAt));
  if (isAiControlled(player)) return anchor + BOT_THINK_MS;
  if (!player.connected) return Math.min(anchor + DISCONNECT_TAKEOVER_MS, Date.parse(state.turnExpiresAt));
  return Date.parse(state.turnExpiresAt);
}
