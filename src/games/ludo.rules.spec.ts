import { advanceTurn, applyMove, createLudoState, DISCONNECT_TAKEOVER_MS, giveControlBack, globalTrackIndex, handToAi, HOME_PROGRESS, BOT_THINK_MS, isAiControlled, legalMoves, pickBotMove, playerFinished, recordFinish, rollForTurn, serverActsAt, threatCount, trackIndexFor } from './ludo.rules';

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

  describe('two players', () => {
    const two = () => createLudoState({
      matchId: 'm', roomCode: 'ABC123', entryFee: 1000, playerCount: 2,
      players: [{ userId: 'a', displayName: 'A' }, { userId: 'b', displayName: 'B', synthetic: true }],
      prizeFirst: 1400, prizeSecond: 600,
    });

    it('seats them in opposite corners (RED and YELLOW), not side by side', () => {
      const s = two();
      expect(s.players.map(p => p.color)).toEqual(['RED', 'YELLOW']);
      expect(s.players[1].synthetic).toBe(true);
      expect(s.players[0].synthetic).toBe(undefined);
    });

    it('starts each colour on its own start square', () => {
      const s = two();
      expect(trackIndexFor(s.players[0], 0)).toBe(0);
      expect(trackIndexFor(s.players[1], 0)).toBe(26);
    });

    it('captures across the two colours', () => {
      const s = two();
      s.players[0].tokens[0].progress = 30; // RED on square 30
      s.players[1].tokens[0].progress = 3;  // YELLOW on square 29
      s.currentSeat = 1;
      rollForTurn(s, 1, 1);
      applyMove(s, 1, 0, 1);                // YELLOW to 30
      expect(s.players[0].tokens[0].progress).toBe(-1);
    });
  });

  describe('bot move choice', () => {
    it('prefers finishing, then capturing, then leaving the yard, then the furthest token', () => {
      const s = createLudoState({
        matchId: 'm', roomCode: 'R', entryFee: 0, playerCount: 4,
        players: [1, 2, 3, 4].map(i => ({ userId: `u${i}`, displayName: `P${i}` })), prizeFirst: 0, prizeSecond: 0,
      });
      const p = s.players[0];
      p.tokens[0].progress = 54; p.tokens[1].progress = 10; p.tokens[2].progress = -1; p.tokens[3].progress = 20;
      expect(pickBotMove(s, 0, 2, legalMoves(s, 0, 2))).toBe(0);        // 54 + 2 = home
      p.tokens[0].progress = -1;
      s.players[1].tokens[0].progress = 25;                              // GREEN on square 38
      p.tokens[1].progress = 34;                                         // +4 lands on 38
      expect(pickBotMove(s, 0, 4, legalMoves(s, 0, 4))).toBe(1);        // capture
      s.players[1].tokens[0].progress = -1;
      expect(pickBotMove(s, 0, 6, legalMoves(s, 0, 6))).toBe(0);        // leave the yard (token 0 is in the yard)
      p.tokens[0].progress = 4; p.tokens[1].progress = 11; p.tokens[2].progress = 14; p.tokens[3].progress = 20; // no safe square in reach
      expect(pickBotMove(s, 0, 3, legalMoves(s, 0, 3))).toBe(3);        // furthest token (20 + 3)
    });
  });

  describe('AI takeover', () => {
    const match = (count: 2 | 4 = 4) => createLudoState({
      matchId: 'm', roomCode: 'R', entryFee: 100, playerCount: count,
      players: Array.from({ length: count }, (_, i) => ({ userId: `u${i}`, displayName: `P${i}` })), prizeFirst: 0, prizeSecond: 0,
    });

    it('waits the full turn timer for a connected human', () => {
      const s = match();
      expect(serverActsAt(s, s.players[0])).toBe(Date.parse(s.turnExpiresAt));
    });

    it('steps in quickly for a human whose connection dropped', () => {
      const s = match();
      s.players[0].connected = false;
      const at = serverActsAt(s, s.players[0]);
      expect(at).toBeLessThanOrEqual(Date.parse(s.turnStartedAt) + DISCONNECT_TAKEOVER_MS);
      expect(at).toBeLessThan(Date.parse(s.turnExpiresAt));
    });

    it('plays at bot speed for a human on autopilot instead of waiting a whole turn each time', () => {
      const s = match();
      handToAi(s.players[0]);
      expect(isAiControlled(s.players[0])).toBe(true);
      expect(s.players[0].bot).toBe(true);
      expect(serverActsAt(s, s.players[0])).toBeLessThanOrEqual(Date.parse(s.turnStartedAt) + BOT_THINK_MS);
    });

    it('hands the seat back the moment the human acts or reconnects, and refreshes their clock', () => {
      const s = match();
      handToAi(s.players[0]);
      s.players[0].connected = false;
      s.players[0].missedTurns = 3;
      s.turnExpiresAt = new Date(Date.now() + 500).toISOString(); // almost out of time
      expect(giveControlBack(s, s.players[0])).toBe(true);
      const p = s.players[0];
      expect([p.autopilot, p.bot, p.connected, p.missedTurns]).toEqual([false, false, true, 0]);
      expect(Date.parse(s.turnExpiresAt) - Date.now()).toBeGreaterThan(s.turnSeconds * 1000 - 1000);
      expect(isAiControlled(p)).toBe(false);
    });
  });

  describe('finishing', () => {
    const match = (count: 2 | 4) => createLudoState({
      matchId: 'm', roomCode: 'R', entryFee: 100, playerCount: count,
      players: Array.from({ length: count }, (_, i) => ({ userId: `u${i}`, displayName: `P${i}` })), prizeFirst: 0, prizeSecond: 0,
    });
    const home = (s: ReturnType<typeof match>, seat: number) => s.players[seat].tokens.forEach(t => { t.progress = HOME_PROGRESS; });

    it('ends a two-player match as soon as one player is home', () => {
      const s = match(2);
      home(s, 1);
      expect(recordFinish(s, s.players[1])).toBe(true);
      expect(s.winnerUserId).toBe('u1');
      expect(s.secondPlaceUserId).toBeUndefined();
    });

    it('does not end a four-player match on the first finisher', () => {
      const s = match(4);
      home(s, 2);
      expect(recordFinish(s, s.players[2])).toBe(false);
      expect(s.winnerUserId).toBe('u2');
    });

    it('ends a four-player match on the second finisher', () => {
      const s = match(4);
      home(s, 2); recordFinish(s, s.players[2]);
      home(s, 0);
      expect(recordFinish(s, s.players[0])).toBe(true);
      expect(s.secondPlaceUserId).toBe('u0');
    });
  });

  describe('smarter AI', () => {
    const match = () => createLudoState({
      matchId: 'm', roomCode: 'R', entryFee: 0, playerCount: 4,
      players: [1, 2, 3, 4].map(i => ({ userId: `u${i}`, displayName: `P${i}` })), prizeFirst: 0, prizeSecond: 0,
    });

    it('counts opponents that can hit a square, and ignores safe squares', () => {
      const s = match();
      // GREEN (start 13) at progress 3 -> square 16; RED token at progress 18 is 2 squares ahead of it.
      s.players[1].tokens[0].progress = 3;
      expect(threatCount(s, 0, 18)).toBe(1);
      expect(threatCount(s, 0, 21)).toBe(0); // square 21 is safe
    });

    it('takes the safe square over a risky one', () => {
      const s = match();
      const p = s.players[0];
      s.players[1].tokens[0].progress = 3;     // GREEN on square 16, threatens squares 17-22
      p.tokens[0].progress = 15;               // +3 -> 18 (in reach of GREEN)
      p.tokens[1].progress = 18;               // +3 -> 21 (safe)
      p.tokens[2].progress = -1; p.tokens[3].progress = -1;
      expect(pickBotMove(s, 0, 3, legalMoves(s, 0, 3))).toBe(1);
    });

    it('rescues a token that is about to be captured', () => {
      const s = match();
      const p = s.players[0];
      s.players[1].tokens[0].progress = 9;     // GREEN on square 22
      p.tokens[0].progress = 24;               // square 24: 2 ahead of GREEN, in danger
      p.tokens[1].progress = 30;               // square 30 is 8 ahead: not in danger
      p.tokens[2].progress = -1; p.tokens[3].progress = -1;
      // A 5 takes token 0 to square 29, 7 ahead of GREEN: out of reach. Token 1 was never at risk.
      expect(pickBotMove(s, 0, 5, legalMoves(s, 0, 5))).toBe(0);
    });
  });

  it('an AI-vs-AI match always reaches a result', () => {
    for (const count of [2, 4] as const) {
      const s = createLudoState({
        matchId: 'm', roomCode: 'R', entryFee: 0, playerCount: count,
        players: Array.from({ length: count }, (_, i) => ({ userId: `u${i}`, displayName: `P${i}`, synthetic: true })), prizeFirst: 0, prizeSecond: 0,
      });
      let over = false;
      for (let step = 0; step < 20000 && !over; step++) {
        const seat = s.currentSeat;
        const r = rollForTurn(s, seat);
        if (r.threeSixPenalty) { s.players[seat].consecutiveSixes = 0; advanceTurn(s, seat, false); continue; }
        if (r.legalMoves.length === 0) { advanceTurn(s, seat, r.dice === 6); continue; }
        applyMove(s, seat, pickBotMove(s, seat, r.dice, r.legalMoves), r.dice);
        over = recordFinish(s, s.players[seat]);
        if (!over) advanceTurn(s, seat, r.dice === 6);
      }
      expect(over).toBe(true);
      expect(s.winnerUserId).toBeTruthy();
    }
  });
});
