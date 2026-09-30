import {
  ROOM_PK_MIN_PARTICIPANTS,
  buildEntrants,
  decideRoomPkResult,
  normalizeRoomPkDuration,
  normalizeRoomPkMode,
  rankEntrants,
  roomPkPhase,
} from './room-pk-rules';

const seats = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, seatNumber: i }));
const scored = (rows: Array<[string, string | null, number]>) => rows.map(([userId, side, score]) => ({ userId, side, score: BigInt(score) }));

describe('room PK rules', () => {
  describe('normalizers', () => {
    it('defaults to INDIVIDUAL and 180s, rejects unknown values', () => {
      expect(normalizeRoomPkMode(undefined)).toBe('INDIVIDUAL');
      expect(normalizeRoomPkMode('TEAMS')).toBe('TEAMS');
      expect(() => normalizeRoomPkMode('FFA')).toThrow();
      expect(normalizeRoomPkDuration(undefined)).toBe(180);
      expect(normalizeRoomPkDuration('300')).toBe(300);
      expect(() => normalizeRoomPkDuration(45)).toThrow();
    });
  });

  describe('buildEntrants', () => {
    it('needs at least two seated people', () => {
      expect(() => buildEntrants(seats(ROOM_PK_MIN_PARTICIPANTS - 1), 'INDIVIDUAL')).toThrow();
    });

    it('INDIVIDUAL puts everyone in, with no sides', () => {
      const e = buildEntrants(seats(4), 'INDIVIDUAL');
      expect(e).toHaveLength(4);
      expect(e.every((x) => x.side === null)).toBe(true);
    });

    it('TEAMS alternates A/B by seat order when no sides are given', () => {
      const e = buildEntrants([...seats(4)].reverse(), 'TEAMS');
      expect(e.map((x) => [x.seatNumber, x.side])).toEqual([[0, 'A'], [1, 'B'], [2, 'A'], [3, 'B']]);
    });

    it('TEAMS honours explicit sides and requires every seat to be assigned', () => {
      const ok = buildEntrants(seats(3), 'TEAMS', { '0': 'A', '1': 'A', '2': 'B' });
      expect(ok.map((x) => x.side)).toEqual(['A', 'A', 'B']);
      expect(() => buildEntrants(seats(3), 'TEAMS', { '0': 'A', '1': 'B' })).toThrow();
      expect(() => buildEntrants(seats(3), 'TEAMS', { '0': 'A', '1': 'C', '2': 'B' })).toThrow();
    });

    it('TEAMS rejects a lopsided split with an empty side', () => {
      expect(() => buildEntrants(seats(3), 'TEAMS', { '0': 'A', '1': 'A', '2': 'A' })).toThrow();
    });

    it('works for every party layout (4, 6, 8, 9, 12 seats)', () => {
      for (const n of [4, 6, 8, 9, 12]) {
        expect(buildEntrants(seats(n), 'TEAMS')).toHaveLength(n);
      }
    });
  });

  describe('rankEntrants', () => {
    it('shares a rank on equal scores (1, 1, 3)', () => {
      const r = rankEntrants(scored([['a', null, 5], ['b', null, 9], ['c', null, 9]]));
      expect(r.map((x) => [x.userId, x.rank])).toEqual([['b', 1], ['c', 1], ['a', 3]]);
    });
  });

  describe('decideRoomPkResult', () => {
    it('INDIVIDUAL: the single highest score wins', () => {
      const r = decideRoomPkResult('INDIVIDUAL', scored([['a', null, 10], ['b', null, 30], ['c', null, 20]]));
      expect(r.winnerUserId).toBe('b');
      expect(r.tie).toBe(false);
      expect(r.sideTotals).toBeNull();
    });

    it('INDIVIDUAL: a tie for first, or nobody scoring, has no winner', () => {
      expect(decideRoomPkResult('INDIVIDUAL', scored([['a', null, 30], ['b', null, 30], ['c', null, 1]])).winnerUserId).toBeNull();
      const zero = decideRoomPkResult('INDIVIDUAL', scored([['a', null, 0], ['b', null, 0]]));
      expect(zero.winnerUserId).toBeNull();
      expect(zero.tie).toBe(true);
    });

    it('TEAMS: pooled totals decide, not the best single player', () => {
      const r = decideRoomPkResult('TEAMS', scored([['a', 'A', 100], ['b', 'B', 40], ['c', 'B', 40], ['d', 'B', 40]]));
      expect(r.sideTotals).toEqual({ A: 100n, B: 120n });
      expect(r.winnerSide).toBe('B');
      expect(r.winnerUserId).toBeNull();
    });

    it('TEAMS: equal totals (including 0-0) is a tie', () => {
      expect(decideRoomPkResult('TEAMS', scored([['a', 'A', 10], ['b', 'B', 10]])).tie).toBe(true);
      expect(decideRoomPkResult('TEAMS', scored([['a', 'A', 0], ['b', 'B', 0]])).winnerSide).toBeNull();
    });
  });

  describe('roomPkPhase', () => {
    const t0 = new Date('2026-01-01T00:00:10Z');
    const pk = { status: 'ACTIVE', startedAt: t0, endsAt: new Date('2026-01-01T00:03:10Z') };
    it('is COUNTDOWN before startedAt, ACTIVE until endsAt, then ENDED', () => {
      expect(roomPkPhase(pk, new Date('2026-01-01T00:00:00Z'))).toBe('COUNTDOWN');
      expect(roomPkPhase(pk, new Date('2026-01-01T00:00:10Z'))).toBe('ACTIVE');
      expect(roomPkPhase(pk, new Date('2026-01-01T00:03:09Z'))).toBe('ACTIVE');
      expect(roomPkPhase(pk, new Date('2026-01-01T00:03:10Z'))).toBe('ENDED');
    });
    it('is ENDED for any non-ACTIVE status, whatever the clock says', () => {
      expect(roomPkPhase({ ...pk, status: 'SETTLED' }, new Date('2026-01-01T00:00:00Z'))).toBe('ENDED');
      expect(roomPkPhase({ ...pk, status: 'CANCELLED' }, new Date('2026-01-01T00:01:00Z'))).toBe('ENDED');
    });
  });
});
