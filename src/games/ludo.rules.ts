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

/**
 * The move a bot (a server bot seat, or a player whose turn timed out) makes:
 * finish a token > capture > leave the yard > advance the furthest token.
 */
export function pickBotMove(state: LudoState, seat: number, dice: number, legal: number[]): number {
  const player = state.players[seat];
  let best = legal[0];
  let bestScore = -Infinity;
  for (const i of legal) {
    const from = player.tokens[i].progress;
    const to = from === -1 ? 0 : from + dice;
    let score = to;
    if (to === HOME_PROGRESS) score += 1000;
    if (capturesOpponent(state, seat, to)) score += 500;
    if (from === -1) score += 300;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}
