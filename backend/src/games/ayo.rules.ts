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

function hasSeedsOnSide(board: number[], seat: 0 | 1): boolean {
  return legalPits(board, seat).length > 0;
}

function wouldFeedOpponent(board: number[], seat: 0 | 1, pit: number): boolean {
  const next = simulateSow(board, seat, pit, 'FOUR', false);
  return hasSeedsOnSide(next.board, seat === 0 ? 1 : 0);
}

/**
 * Lagos Ayo/Ayò Ọlọ́pón default used by Rryda:
 * 12 pits, four seeds each, counter-clockwise relay sowing.
 * A house that reaches four is captured; relay continues when the last
 * seed lands in an occupied house. Feeding is mandatory when the opponent
 * has no seeds. A match is won when a player captures 25+ seeds or the
 * board can no longer be legally continued.
 *
 * The engine also exposes TWO_THREE for variants that use the Oware-style
 * two/three capture rule.
 */
export function simulateSow(
  input: number[],
  seat: 0 | 1,
  pit: number,
  captureMode: AyoCaptureMode = 'FOUR',
  enforceFeeding = true,
): { board: number[]; captured: number; path: number[] } {
  const board = input.slice();
  if (board.length !== PITS) throw new Error('Ayo board must have 12 pits');
  if (!pitOwnedBySeat(pit, seat) || board[pit] <= 0) throw new Error('Choose a non-empty pit on your side');

  const opponent = seat === 0 ? 1 : 0;
  if (enforceFeeding && !hasSeedsOnSide(board, opponent)) {
    const moves = legalPits(board, seat).filter((p) => wouldFeedOpponent(board, seat, p));
    if (moves.length > 0 && !wouldFeedOpponent(board, seat, pit)) {
      throw new Error('You must feed your opponent');
    }
  }

  let current = pit;
  let hand = board[current];
  board[current] = 0;
  const path: number[] = [];
  let captured = 0;

  while (hand > 0) {
    let next = (current + 1) % PITS; // counter-clockwise around the indexed board
    current = next;
    board[current] += 1;
    hand -= 1;
    path.push(current);

    if (captureMode === 'FOUR') {
      // In the Lagos four-seed variant, completing a house to four wins that house.
      if (board[current] === 4) {
        board[current] = 0;
        captured += 4;
      }
    }

    // Relay sowing: if the final seed landed in an occupied house, pick it up
    // and continue. A newly captured empty house ends the sow.
    if (hand === 0 && board[current] > 0) {
      hand = board[current];
      board[current] = 0;
      continue;
    }
  }

  if (captureMode === 'TWO_THREE') {
    // Oware-style capture is applied only to the opponent's side, walking
    // backwards from the final pit.
    let p = current;
    while (sideOfPit(p) === opponent && (board[p] === 2 || board[p] === 3)) {
      captured += board[p];
      board[p] = 0;
      p = (p - 1 + PITS) % PITS;
    }
  }

  return { board, captured, path };
}

export function makeMove(
  state: Pick<AyoState, 'board' | 'captured' | 'currentSeat'>,
  pit: number,
  captureMode: AyoCaptureMode = 'FOUR',
) {
  const seat = state.currentSeat;
  const legal = legalPits(state.board, seat);
  if (!legal.includes(pit)) throw new Error('That pit is not playable');
  const result = simulateSow(state.board, seat, pit, captureMode, true);
  const captured: [number, number] = [...state.captured] as [number, number];
  captured[seat] += result.captured;

  const nextSeat = seat === 0 ? 1 : 0;
  const opponentHasMove = legalPits(result.board, nextSeat).length > 0;
  const currentHasMove = legalPits(result.board, seat).length > 0;

  let finished = captured[seat] >= 25;
  let winnerSeat: 0 | 1 | null = finished ? seat : null;

  if (!finished && !opponentHasMove) {
    // If the opponent has no seeds, the current player must feed them where
    // possible. If no legal feed exists, the remaining seeds are awarded and
    // the match ends.
    const feedMoves = legalPits(result.board, seat).filter((p) => wouldFeedOpponent(result.board, seat, p));
    if (feedMoves.length === 0) {
      let remaining = 0;
      for (const n of result.board) remaining += n;
      captured[seat] += remaining;
      const other = captured[nextSeat];
      winnerSeat = captured[seat] === other ? null : (captured[seat] > other ? seat : nextSeat);
      finished = true;
    }
  }

  if (!finished && !currentHasMove && !opponentHasMove) {
    const remaining = result.board.reduce((a, b) => a + b, 0);
    captured[0] += Math.floor(remaining / 2);
    captured[1] += remaining - Math.floor(remaining / 2);
    winnerSeat = captured[0] === captured[1] ? null : (captured[0] > captured[1] ? 0 : 1);
    finished = true;
  }

  return { ...result, captured, nextSeat, finished, winnerSeat };
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
