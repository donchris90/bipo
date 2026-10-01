import { AYO_MAX_TURNS, createInitialAyoState, initialAyoBoard, legalPits, makeMove, simulateSow } from './ayo.rules';

const fresh = () => createInitialAyoState({
  matchId: 'm', roomCode: 'ABC123', entryFee: 100,
  players: [{ userId: 'a', displayName: 'A', seat: 0 }, { userId: 'b', displayName: 'B', seat: 1 }],
  turnSeconds: 30,
});

describe('Ayo rules', () => {
  it('starts with 48 seeds and four in every pit', () => {
    const board = initialAyoBoard();
    expect(board).toHaveLength(12);
    expect(board.reduce((a, b) => a + b, 0)).toBe(48);
    expect(board.every(x => x === 4)).toBe(true);
  });

  it('only allows a player to select their own non-empty pits', () => {
    expect(legalPits(initialAyoBoard(), 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(legalPits(initialAyoBoard(), 1)).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('sows one lap counter-clockwise and stops (no relay)', () => {
    const r = simulateSow(initialAyoBoard(), 0, 4, 'TWO_THREE', false);
    expect(r.board).toEqual([4, 4, 4, 4, 0, 5, 5, 5, 5, 4, 4, 4]);
    expect(r.path).toEqual([5, 6, 7, 8]);
  });

  it('every opening move terminates in both capture modes', () => {
    for (const mode of ['TWO_THREE', 'FOUR'] as const) for (let p = 0; p < 6; p++) {
      const r = simulateSow(initialAyoBoard(), 0, p, mode, true);
      expect(r.board.reduce((a, b) => a + b, 0) + r.captured).toBe(48);
    }
  });

  it('captures 2s and 3s backwards on the opponent side', () => {
    const board = [0, 0, 0, 0, 0, 2, 1, 2, 0, 1, 1, 1];
    const r = simulateSow(board, 0, 5, 'TWO_THREE', false); // sows 6,7 -> 2,3
    expect(r.captured).toBe(5);
    expect(r.board[6]).toBe(0);
    expect(r.board[7]).toBe(0);
  });

  it('does not allow a grand slam', () => {
    const board = [0, 0, 0, 0, 0, 2, 1, 2, 0, 0, 0, 0];
    const r = simulateSow(board, 0, 5, 'TWO_THREE', false);
    expect(r.captured).toBe(0);
  });

  it('skips the origin pit with 12+ seeds', () => {
    const board = [12, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    const r = simulateSow(board, 0, 0, 'TWO_THREE', false);
    expect(r.board[0]).toBe(0);
    expect(r.path).not.toContain(0);
  });

  it('rejects selecting the opponent side', () => {
    expect(() => simulateSow(initialAyoBoard(), 0, 6)).toThrow();
  });

  it('returns a complete state after a move', () => {
    const r = makeMove(fresh(), 0, 'TWO_THREE');
    expect(r.nextSeat).toBe(1);
    expect(r.path.length).toBeGreaterThan(0);
  });

  it('random full games always finish and conserve seeds', () => {
    for (const mode of ['TWO_THREE', 'FOUR'] as const) for (let g = 0; g < 300; g++) {
      const s: any = fresh();
      let done = false;
      for (let t = 0; t < AYO_MAX_TURNS + 5 && !done; t++) {
        const opts = legalPits(s.board, s.currentSeat).filter(p => { try { makeMove(s, p, mode); return true; } catch { return false; } });
        expect(opts.length).toBeGreaterThan(0);
        const r = makeMove(s, opts[Math.floor(Math.random() * opts.length)], mode);
        s.board = r.board; s.captured = r.captured; s.currentSeat = r.nextSeat; s.turnNumber += 1;
        expect(r.board.reduce((a: number, b: number) => a + b, 0) + r.captured[0] + r.captured[1]).toBe(48);
        done = r.finished;
      }
      expect(done).toBe(true);
    }
  });
});
