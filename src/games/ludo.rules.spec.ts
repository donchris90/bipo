import { advanceTurn, applyMove, createLudoState, globalTrackIndex, HOME_PROGRESS, legalMoves, playerFinished, rollForTurn } from './ludo.rules';

describe('Ludo rules', () => {
  const state = () => createLudoState({
    matchId: 'm', roomCode: 'ABC123', entryFee: 1000, playerCount: 4,
    players: [1, 2, 3, 4].map(i => ({ userId: `u${i}`, displayName: `P${i}` })),
    prizeFirst: 2800, prizeSecond: 1200,
  });

  it('gives an extra turn on a six', () => {
    const s = state();
    const roll = rollForTurn(s, 0, 6);
    expect(roll.threeSixPenalty).toBe(false);
    applyMove(s, 0, 0, 6);
    advanceTurn(s, 0, true);
    expect(s.currentSeat).toBe(0);
    expect(s.players[0].tokens[0].progress).toBe(0);
  });

  it('cancels the third consecutive six and passes the turn', () => {
    const s = state();
    rollForTurn(s, 0, 6);
    rollForTurn(s, 0, 6);
    const third = rollForTurn(s, 0, 6);
    expect(third.threeSixPenalty).toBe(true);
    expect(third.legalMoves).toEqual([]);
    expect(s.lastDice?.penalty).toBe(true);
    advanceTurn(s, 0, false);
    expect(s.currentSeat).toBe(1);
  });

  it('brings a token out on a six', () => {
    const s = state();
    rollForTurn(s, 0, 6);
    applyMove(s, 0, 2, 6);
    expect(s.players[0].tokens[2].progress).toBe(0);
  });

  it('captures an opponent on a non-safe square', () => {
    const s = state();
    // Seat 0 token on global square 1; seat 1 token (start 13) reaches it at progress 40.
    s.players[0].tokens[0].progress = 1;
    s.players[1].tokens[0].progress = 39;
    s.currentSeat = 1;
    rollForTurn(s, 1, 1);
    applyMove(s, 1, 0, 1);
    expect(s.players[0].tokens[0].progress).toBe(-1);
  });

  it('does not capture on a safe square', () => {
    const s = state();
    // Global square 8 is a star square. Seat 0 progress 8 -> square 8.
    s.players[1].tokens[0].progress = 8;
    s.players[0].tokens[0].progress = 4;
    rollForTurn(s, 0, 4);
    applyMove(s, 0, 0, 4);
    expect(s.players[1].tokens[0].progress).toBe(8);
  });

  it('leaves the shared ring after 51 squares and enters the home lane', () => {
    expect(globalTrackIndex(0, 50)).toBe(50);
    expect(globalTrackIndex(0, 51)).toBeNull();
    expect(globalTrackIndex(2, 50)).toBe((26 + 50) % 52);
  });

  it('needs an exact roll to reach home', () => {
    const s = state();
    s.players[0].tokens[0].progress = HOME_PROGRESS - 3;
    expect(legalMoves(s, 0, 4)).not.toContain(0);
    expect(legalMoves(s, 0, 3)).toContain(0);
    s.players[0].tokens[1].progress = HOME_PROGRESS;
    expect(legalMoves(s, 0, 1)).not.toContain(1);
  });

  it('finishes a player when all four tokens are home', () => {
    const s = state();
    s.players[0].tokens.forEach(t => { t.progress = HOME_PROGRESS; });
    expect(playerFinished(s.players[0])).toBe(true);
  });

  it('records the roll even when the turn passes with no legal move', () => {
    const s = state();
    const r = rollForTurn(s, 0, 3); // all tokens in base, not a six
    expect(r.legalMoves).toEqual([]);
    expect(s.lastDice).toMatchObject({ seat: 0, value: 3, noMove: true, penalty: false });
    advanceTurn(s, 0, false);
    expect(s.lastRoll).toBeNull();
    expect(s.lastDice?.value).toBe(3);
  });
});
