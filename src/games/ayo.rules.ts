export type AyoCaptureMode = 'FOUR' | 'TWO_THREE';

export type AyoState = {
  matchId: string;
  roomCode: string;
  entryFee: number;
  status: 'WAITING' | 'ACTIVE' | 'FINISHED' | 'CANCELLED';
  board: number[];
  captured: [number, number];
  currentSeat: 0 | 1;
  players: { userId: string; displayName: string; seat: 0 | 1; connected: boolean }[];
  turnNumber: number;
  turnStartedAt: string;
  turnExpiresAt: string;
  turnSeconds: number;
  winnerUserId?: string;
  lastMove?: { seat: 0 | 1; pit: number; captured: number; path: number[] } | null;
  serverNow: number;
  prizePool: number;
  prizePayout: number;
  disconnectedAt?: [number | null, number | null];
  reconnectGraceSeconds: number;
};

const INITIAL = 4;
const PITS = 12;
const TOTAL_SEEDS = 48;
const WIN_SEEDS = 25;
/**
 * A game that is still going after this many turns is ended: each player keeps the seeds on
 * their own side. Late-game positions with a handful of seeds can otherwise circle forever.
 */
export const AYO_MAX_TURNS = 300;

export function initialAyoBoard(): number[] {
  return Array(PITS).fill(INITIAL);
}

export function sideOfPit(pit: number): 0 | 1 {
  return pit < 6 ? 0 : 1;
}

export function pitOwnedBySeat(pit: number, seat: 0 | 1): boolean {
  return sideOfPit(pit) === seat;
}

export function legalPits(board: number[], seat: 0 | 1): number[] {
  return board
    .map((seeds, i) => (pitOwnedBySeat(i, seat) && seeds > 0 ? i : -1))
    .filter((i) => i >= 0);
}

function seedsOnSide(board: number[], seat: 0 | 1): number {
  let n = 0;
  for (let i = 0; i < PITS; i++) if (sideOfPit(i) === seat) n += board[i];
  return n;
}

function wouldFeedOpponent(board: number[], seat: 0 | 1, pit: number, captureMode: AyoCaptureMode): boolean {
  const next = simulateSow(board, seat, pit, captureMode, false);
  return seedsOnSide(next.board, seat === 0 ? 1 : 0) > 0;
}

function isCapturable(seeds: number, captureMode: AyoCaptureMode) {
  return captureMode === 'FOUR' ? seeds === 4 : seeds === 2 || seeds === 3;
}

/**
 * Ayò Ọlọ́pón, as played in Yorubaland (the same family as Oware abápa):
 *  - 12 pits, 4 seeds each; a player owns the six pits on their side.
 *  - Pick up every seed in one of your pits and sow one per pit, counter-clockwise, in a SINGLE
 *    lap. There is no relay sowing: the move always ends when the hand is empty. (The previous
 *    engine relayed from any occupied pit and never terminated, which froze the whole server.)
 *  - With 12+ seeds the starting pit is skipped on the way round.
 *  - Capture: if the last seed lands on the OPPONENT's side and makes that pit 2 or 3, those
 *    seeds are captured, and so are the pits just before it on the opponent's side while they
 *    also hold 2 or 3. (captureMode 'FOUR' is a house variant: the same, but on exactly 4.)
 *  - A move that would capture every seed the opponent has captures nothing (no "grand slam").
 *  - If the opponent has no seeds you must feed them when you can.
 *  - First to 25 wins.
 */
export function simulateSow(
  input: number[],
  seat: 0 | 1,
  pit: number,
  captureMode: AyoCaptureMode = 'TWO_THREE',
  enforceFeeding = true,
): { board: number[]; captured: number; path: number[] } {
  const board = input.slice();
  if (board.length !== PITS) throw new Error('Ayo board must have 12 pits');
  if (!Number.isInteger(pit) || pit < 0 || pit >= PITS) throw new Error('Choose a pit on your side');
  if (!pitOwnedBySeat(pit, seat) || board[pit] <= 0) throw new Error('Choose a non-empty pit on your side');

  const opponent: 0 | 1 = seat === 0 ? 1 : 0;
  if (enforceFeeding && seedsOnSide(board, opponent) === 0) {
    const feeding = legalPits(board, seat).filter((p) => wouldFeedOpponent(board, seat, p, captureMode));
    if (feeding.length > 0 && !feeding.includes(pit)) throw new Error('You must give your opponent seeds');
  }

  let hand = board[pit];
  board[pit] = 0;
  let current = pit;
  const path: number[] = [];
  // Single lap. Bounded by the number of seeds in hand (plus at most a few skipped origin pits).
  while (hand > 0) {
    current = (current + 1) % PITS;
    if (current === pit) continue; // 12+ seeds: skip the pit the seeds came from
    board[current] += 1;
    hand -= 1;
    path.push(current);
  }

  let captured = 0;
  if (sideOfPit(current) === opponent && isCapturable(board[current], captureMode)) {
    const after = board.slice();
    let take = 0;
    let p = current;
    while (sideOfPit(p) === opponent && isCapturable(after[p], captureMode)) {
      take += after[p];
      after[p] = 0;
      p = (p - 1 + PITS) % PITS;
    }
    // No grand slam: wiping out the opponent's whole side captures nothing.
    if (seedsOnSide(after, opponent) > 0) {
      for (let i = 0; i < PITS; i++) board[i] = after[i];
      captured = take;
    }
  }

  return { board, captured, path };
}

export function makeMove(
  state: Pick<AyoState, 'board' | 'captured' | 'currentSeat'> & { turnNumber?: number },
  pit: number,
  captureMode: AyoCaptureMode = 'TWO_THREE',
) {
  const seat = state.currentSeat;
  const legal = legalPits(state.board, seat);
  if (!legal.includes(pit)) throw new Error('That pit is not playable');
  const result = simulateSow(state.board, seat, pit, captureMode, true);
  const captured: [number, number] = [...state.captured] as [number, number];
  captured[seat] += result.captured;

  const nextSeat: 0 | 1 = seat === 0 ? 1 : 0;
  let finished = false;
  let winnerSeat: 0 | 1 | null = null;

  const settleBySides = () => {
    // Each player keeps what is on their own side, then compare totals.
    captured[0] += seedsOnSide(result.board, 0);
    captured[1] += seedsOnSide(result.board, 1);
    for (let i = 0; i < PITS; i++) result.board[i] = 0;
    winnerSeat = captured[0] === captured[1] ? null : (captured[0] > captured[1] ? 0 : 1);
    finished = true;
  };

  if (captured[seat] >= WIN_SEEDS) {
    finished = true;
    winnerSeat = seat;
  } else if (captured[nextSeat] >= WIN_SEEDS) {
    finished = true;
    winnerSeat = nextSeat;
  } else if (seedsOnSide(result.board, nextSeat) === 0) {
    // Opponent has nothing to play. If we can never feed them, the game ends and the remaining
    // seeds go to the player who still has them.
    const canFeed = legalPits(result.board, seat).some((p) => wouldFeedOpponent(result.board, seat, p, captureMode));
    if (!canFeed) settleBySides();
  } else if ((state.turnNumber ?? 0) + 1 >= AYO_MAX_TURNS) {
    settleBySides();
  } else if (captured[0] === TOTAL_SEEDS / 2 && captured[1] === TOTAL_SEEDS / 2) {
    finished = true;
    winnerSeat = null;
  }

  // If the game isn't finished but the next player has no move (can only happen when they were
  // just emptied and we CAN feed), play passes back — the service handles that via nextSeat.
  const opponentHasMove = legalPits(result.board, nextSeat).length > 0;
  const resolvedNext: 0 | 1 = !finished && !opponentHasMove ? seat : nextSeat;

  return { ...result, captured, nextSeat: resolvedNext, finished, winnerSeat };
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
    currentSeat: 0, players: params.players.map(p => ({ ...p, connected: true })),
    turnNumber: 1,
    turnStartedAt: new Date(now).toISOString(),
    turnExpiresAt: new Date(now + params.turnSeconds * 1000).toISOString(),
    turnSeconds: params.turnSeconds, lastMove: null, serverNow: now,
    prizePool: params.entryFee * params.players.length, prizePayout: 0,
    disconnectedAt: [null, null], reconnectGraceSeconds: 60,
  };
}
