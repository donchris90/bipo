import { advanceTurn, applyMove, createLudoState, rollForTurn } from './ludo.rules';

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
    // Put player 1 token at global track 1 (progress 1 from seat 0),
    // player 2 reaches the same global track with progress 40 (start 13 + 40 = 1).
    s.players[0].tokens[0].progress = 1;
    s.players[1].tokens[0].progress = 39;
    rollForTurn(s, 1, 1);
    applyMove(s, 1, 0, 1);
    expect(s.players[0].tokens[0].progress).toBe(-1);
  });
});
