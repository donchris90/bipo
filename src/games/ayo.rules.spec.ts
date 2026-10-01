import {
  AyoState, applyAyoDecision, applyAyoMove, chooseBotPit, createInitialAyoState, initialAyoBoard,
  legalPits, MAX_ROUNDS, normalizeAyoState, ownersForPits, pitCount, simulateSow,
} from './ayo.rules';

const fresh = (): AyoState => createInitialAyoState({
  matchId: 'm', roomCode: 'ABC123', entryFee: 100,
  players: [{ userId: 'a', displayName: 'A', seat: 0 }, { userId: 'b', displayName: 'B', seat: 1 }],
  turnSeconds: 30,
});
const total = (s: AyoState) => s.board.reduce((a, b) => a + b, 0) + s.captured[0] + s.captured[1];
const rand = (n: number) => Math.floor(Math.random() * n);

describe('Ayo house rules', () => {
  it('starts with 6 pits of 4 each', () => {
    const s = fresh();
    expect(s.board).toEqual(initialAyoBoard());
    expect(legalPits(s.board, 0, s.owners)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(legalPits(s.board, 1, s.owners)).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('relays from an occupied pit and stops on an empty one', () => {
    // pit 0 has 2: drops in 1 (empty -> 1) and 2 (had 1 -> 2, occupied -> relay 2): 3, 4 (empty) -> stop
    const r = simulateSow([2, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1], 0);
    expect(r.board).toEqual([0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1]);
    expect(r.events.filter(e => e.t === 'pick')).toHaveLength(2);
  });

  it('packs any pit that reaches 4 for the sower, and a packed last seed ends the turn', () => {
    const r = simulateSow([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((v, i) => (i === 1 ? 3 : v)), 0, 0);
    expect(r.packed).toBe(4);
    expect(r.board[1]).toBe(0);
    expect(r.events.some(e => e.t === 'pack' && e.pit === 1 && e.seat === 0)).toBe(true);
  });

  it('mid-sow 4 on the opponent side goes to the opponent', () => {
    // seat 0 sows 2 seeds from pit 5: pit 6 (opp, 3 -> 4) mid-sow -> opponent packs; pit 7 empty -> stop
    const board = [0, 0, 0, 0, 0, 2, 3, 0, 1, 1, 1, 1];
    const r = simulateSow(board, 5, 0);
    expect(r.packedBy).toEqual([0, 4]);
    expect(r.packed).toBe(0);
    expect(r.lastReceiver).toBe(1);
    expect(r.events.some(e => e.t === 'pack' && e.pit === 6 && e.seat === 1)).toBe(true);
  });

  it('last seed making 4 on the opponent side goes to the sower', () => {
    // seat 0 sows 1 seed from pit 5 into pit 6 (3 -> 4) as the LAST seed -> seat 0 packs
    const board = [0, 0, 0, 0, 0, 1, 3, 0, 1, 1, 1, 1];
    const r = simulateSow(board, 5, 0);
    expect(r.packedBy).toEqual([4, 0]);
    expect(r.lastReceiver).toBe(0);
  });

  it('mid-sow 4 on my own side is mine', () => {
    // seat 0 sows 2 from pit 0: pit 1 (3 -> 4) mid-sow, own side -> seat 0; pit 2 empty -> stop
    const board = [2, 3, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    expect(simulateSow(board, 0, 0).packedBy).toEqual([4, 0]);
  });

  it('a 4 received from the opponent sowing counts for the final-four rule', () => {
    // seat 0 plays pit 5 (2 seeds): pit 6 -> 4 mid-sow for seat 1, pit 7 empty. 4 seeds left -> seat 1 gets them.
    const s = normalizeAyoState({ ...fresh(), board: [0, 0, 0, 0, 0, 2, 3, 0, 1, 1, 1, 0], captured: [20, 20] as [number, number], lastPacker: 0 as const });
    const { state } = applyAyoMove(s, 5);
    expect(state.lastRound?.packed).toEqual([20, 28]);
    expect(state.lastRound?.finalFourTo).toBe(1);
  });

  it('every move terminates and conserves seeds', () => {
    for (let p = 0; p < 6; p++) {
      const r = simulateSow(initialAyoBoard(), p);
      expect(r.board.reduce((a, b) => a + b, 0) + r.packed).toBe(48);
    }
  });

  it('gives the last 4 seeds to the previous packer and refills the next round in 4s', () => {
    const s = normalizeAyoState({ ...fresh(), board: [0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0], captured: [24, 20] as [number, number], lastPacker: 1 as const });
    // seat 0 plays pit 2 (1 seed) -> lands in empty pit 3; 4 seeds remain on the board -> final four to seat 1
    const { state } = applyAyoMove(s, 2);
    expect(state.round).toBe(2);
    expect(state.lastRound?.packed).toEqual([24, 24]);
    expect(state.lastRound?.finalFourTo).toBe(1);
    expect(state.board.every(x => x === 4)).toBe(true);
    expect(pitCount(state.owners, 0)).toBe(6);
    expect(state.roundStarter).toBe(1); // rounds alternate
    expect(state.currentSeat).toBe(1);
  });

  it('28 vs 20 gives 7 pits vs 5', () => {
    const s = normalizeAyoState({ ...fresh(), board: [0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0], captured: [24, 20] as [number, number], lastPacker: 0 as const });
    const { state } = applyAyoMove(s, 2);
    expect(state.lastRound?.pits).toEqual([7, 5]);
    expect(pitCount(state.owners, 0)).toBe(7);
    expect(state.owners).toEqual(ownersForPits(7));
  });

  it('a player with no pits loses; with one pit gets the quit/continue choice', () => {
    const lose = normalizeAyoState({ ...fresh(), board: [0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0], captured: [0, 44] as [number, number], lastPacker: 1 as const });
    const end = applyAyoMove(lose, 2).state;
    expect(end.status).toBe('FINISHED');
    expect(end.winnerUserId).toBe('b');
    expect(end.endReason).toBe('NO_PITS');

    const one = normalizeAyoState({ ...fresh(), board: [0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0], captured: [4, 40] as [number, number], lastPacker: 0 as const });
    const st = applyAyoMove(one, 2).state; // seat 0 ends with 8 = 2 pits
    expect(st.decision).toBeNull();
    const one2 = normalizeAyoState({ ...fresh(), board: [0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0], captured: [4, 40] as [number, number], lastPacker: 1 as const });
    const st2 = applyAyoMove(one2, 2).state; // seat 0 ends with 4 = 1 pit
    expect(st2.decision?.seat).toBe(0);
    expect(() => applyAyoMove(st2, st2.owners.indexOf(st2.currentSeat))).toThrow();
    expect(applyAyoDecision(st2, 0, true).winnerUserId).toBe('b');
    expect(applyAyoDecision(st2, 0, false).decision).toBeNull();
  });

  it('a player whose pits are all empty skips their turn', () => {
    const s = normalizeAyoState({ ...fresh(), board: [1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 2], captured: [20, 20] as [number, number], currentSeat: 0 as const });
    // seat 0 plays pit 0 -> pit 1 (empty), stop. Seat 1 still has seeds, so it's their turn.
    expect(applyAyoMove(s, 0).state.currentSeat).toBe(1);
    const t = normalizeAyoState({ ...fresh(), board: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1].map((v, i) => (i === 3 ? 2 : i === 5 ? 3 : v)), captured: [20, 22] as [number, number], currentSeat: 1 as const });
    // seat 1 plays pit 11 (1 seed) -> pit 0 (empty). Seat 0 has seeds -> seat 0 plays.
    expect(applyAyoMove(t, 11).state.currentSeat).toBe(0);
  });

  it('records events that replay to the final board', () => {
    const s = fresh();
    const { state } = applyAyoMove(s, 3);
    const b = state.lastMove!.before!.slice();
    for (const e of state.lastMove!.events!) {
      if (e.t === 'pick') b[e.pit] = 0;
      if (e.t === 'drop') b[e.pit] += 1;
      if (e.t === 'pack') b[e.pit] = 0;
    }
    expect(b).toEqual(state.board);
    expect(state.lastMove!.animMs).toBeGreaterThan(0);
  });

  it('random bot-vs-bot games always finish and always conserve 48 seeds', () => {
    let finished = 0;
    for (let g = 0; g < 100; g++) {
      let s = fresh();
      for (let i = 0; i < 20000 && s.status === 'ACTIVE'; i++) {
        if (s.decision) { s = applyAyoDecision(s, s.decision.seat, false); continue; }
        const pit = chooseBotPit(s, rand);
        expect(pit).not.toBeNull();
        s = applyAyoMove(s, pit!).state;
        expect(total(s)).toBe(48);
        expect(s.round).toBeLessThanOrEqual(MAX_ROUNDS);
      }
      if (s.status === 'FINISHED') finished++;
    }
    expect(finished).toBe(100);
  });
});
