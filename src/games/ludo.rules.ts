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
}
export interface LudoState {
  matchId: string;
  roomCode: string;
  playerCount: 2 | 4;
  entryFee: number;
  prizeFirst: number;
  prizeSecond: number;
  status: LudoStatus;
  currentSeat: number;
  turnNumber: number;
  turnStartedAt: string;
  turnExpiresAt: string;
  turnSeconds: number;
  lastRoll: number | null;
  lastMove: { userId: string; tokenIndex: number; from: number; to: number; capturedUserId?: string } | null;
  players: LudoPlayerState[];
  winnerUserId?: string;
  secondPlaceUserId?: string;
}

export const COLORS: LudoPlayerColor[] = ['RED', 'GREEN', 'YELLOW', 'BLUE'];
export const TURN_MS = 20_000;
export const RECONNECT_GRACE_MS = 120_000;

// Eight classic-style safe squares. Start squares are safe too.
const SAFE_TRACK = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const START_OFFSETS = [0, 13, 26, 39];

export function createLudoState(params: {
  matchId: string;
  roomCode: string;
  entryFee: number;
  playerCount: 2 | 4;
  players: Array<{ userId: string; displayName: string }>;
  prizeFirst: number;
  prizeSecond: number;
}): LudoState {
  const now = Date.now();
  return {
    matchId: params.matchId,
    roomCode: params.roomCode,
    playerCount: params.playerCount,
    entryFee: params.entryFee,
    prizeFirst: params.prizeFirst,
    prizeSecond: params.prizeSecond,
    status: 'ACTIVE',
    currentSeat: 0,
    turnNumber: 1,
    turnStartedAt: new Date(now).toISOString(),
    turnExpiresAt: new Date(now + (params.turnSeconds ?? TURN_MS / 1000) * 1000).toISOString(),
    turnSeconds: params.turnSeconds ?? TURN_MS / 1000,
    lastRoll: null,
    lastMove: null,
    players: params.players.map((p, seat) => ({
      userId: p.userId,
      displayName: p.displayName,
      color: COLORS[seat],
      seat,
      connected: true,
      bot: false,
      tokens: [{ progress: -1 }, { progress: -1 }, { progress: -1 }, { progress: -1 }],
      consecutiveSixes: 0,
    })),
  };
}

export function globalTrackIndex(seat: number, progress: number): number | null {
  if (progress < 0 || progress > 51) return null;
  return (START_OFFSETS[seat] + progress) % 52;
}

export function isSafeTrack(index: number): boolean { return SAFE_TRACK.has(index); }

export function legalMoves(state: LudoState, seat: number, dice: number): number[] {
  const player = state.players[seat];
  if (!player) return [];
  return player.tokens.flatMap((token, i) => {
    if (token.progress === 57) return [];
    if (token.progress === -1) return dice === 6 ? [i] : [];
    return token.progress + dice <= 57 ? [i] : [];
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
  const landing = globalTrackIndex(seat, to);
  if (landing !== null && !isSafeTrack(landing)) {
    for (const opponent of state.players) {
      if (opponent.seat === seat) continue;
      for (const other of opponent.tokens) {
        if (globalTrackIndex(opponent.seat, other.progress) === landing) {
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
  return player.tokens.every(t => t.progress === 57);
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
  return { dice, threeSixPenalty, legalMoves: threeSixPenalty ? [] : legalMoves(state, seat, dice) };
}
