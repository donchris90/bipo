import { createInitialAyoState, initialAyoBoard, legalPits, makeMove, simulateSow } from './ayo.rules';

describe('Ayo rules', () => {
  it('starts with 48 seeds and four in every pit', () => {
    const board = initialAyoBoard();
    expect(board).toHaveLength(12);
    expect(board.reduce((a, b) => a + b, 0)).toBe(48);
    expect(board.every(x => x === 4)).toBe(true);
  });

  it('only allows a player to select their own non-empty pits', () => {
    expect(legalPits(initialAyoBoard(), 0)).toEqual([0,1,2,3,4,5]);
    expect(legalPits(initialAyoBoard(), 1)).toEqual([6,7,8,9,10,11]);
  });

  it('sows four seeds counter-clockwise into the next four pits', () => {
    const r = simulateSow(initialAyoBoard(), 0, 0, 'TWO_THREE', false);
    expect(r.board[0]).toBe(0);
    expect(r.board[1]).toBe(5);
    expect(r.board[2]).toBe(5);
    expect(r.board[3]).toBe(5);
    expect(r.board[4]).toBe(5);
  });

  it('rejects selecting the opponent side', () => {
    expect(() => simulateSow(initialAyoBoard(), 0, 6)).toThrow();
  });

  it('returns a complete state after a move', () => {
    const state = createInitialAyoState({
      matchId: 'm', roomCode: 'ABC123', entryFee: 100,
      players: [{userId:'a',displayName:'A',seat:0},{userId:'b',displayName:'B',seat:1}],
      turnSeconds: 30,
    });
    const r = makeMove(state, 0, 'TWO_THREE');
    expect(r.nextSeat).toBe(1);
    expect(r.path.length).toBeGreaterThan(0);
  });
});
