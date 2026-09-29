import { BadRequestException } from '@nestjs/common';

// Pure rules for Multi-guest / Room PK. No database, no Nest DI, so they are unit-tested directly
// (room-pk-rules.spec.ts) and shared by RoomPkService.

export const ROOM_PK_MODES = ['INDIVIDUAL', 'TEAMS'] as const;
export type RoomPkMode = (typeof ROOM_PK_MODES)[number];
export type RoomPkSide = 'A' | 'B';

// Same lengths as 1v1 PK (PK_DURATIONS_SEC in pk.service.ts) so the app can reuse one picker.
export const ROOM_PK_DURATIONS_SEC = [180, 300, 600, 900] as const;
export const DEFAULT_ROOM_PK_DURATION_SEC = 180;
export const ROOM_PK_MIN_PARTICIPANTS = 2;
// Get-ready time between the host pressing Start and gifts starting to count (same as 1v1 PK's
// COUNTDOWN_MS). Nothing is stored for it: the PK row's startedAt is simply this far in the future.
export const ROOM_PK_COUNTDOWN_MS = 10_000;

export type RoomPkPhase = 'COUNTDOWN' | 'ACTIVE' | 'ENDED';

// Where a Room PK is on the timeline right now, from its stored status and timestamps.
export function roomPkPhase(pk: { status: string; startedAt: Date; endsAt: Date }, now: Date = new Date()): RoomPkPhase {
  if (pk.status !== 'ACTIVE') return 'ENDED';
  if (now < pk.startedAt) return 'COUNTDOWN';
  return now < pk.endsAt ? 'ACTIVE' : 'ENDED';
}
// How long a finished Room PK keeps showing its result before current() reports "no PK".
export const ROOM_PK_RESULT_MS = 30_000;

export interface SeatedUser {
  userId: string;
  seatNumber: number;
}

export interface RoomPkEntrant extends SeatedUser {
  side: RoomPkSide | null;
}

export function normalizeRoomPkMode(value: unknown): RoomPkMode {
  if (value === undefined || value === null || value === '') return 'INDIVIDUAL';
  if ((ROOM_PK_MODES as readonly unknown[]).includes(value)) return value as RoomPkMode;
  throw new BadRequestException(`mode must be one of: ${ROOM_PK_MODES.join(', ')}`);
}

export function normalizeRoomPkDuration(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_ROOM_PK_DURATION_SEC;
  const n = Number(value);
  if (!(ROOM_PK_DURATIONS_SEC as readonly number[]).includes(n)) {
    throw new BadRequestException(`PK length must be one of: ${ROOM_PK_DURATIONS_SEC.map((x) => `${x / 60} min`).join(', ')}`);
  }
  return n;
}

// Who competes and, for TEAMS, on which side. Everyone seated competes (the host sits in seat 0).
// `sidesBySeat` maps seatNumber -> 'A' | 'B'; if omitted, seats alternate A, B, A, B by seat order.
export function buildEntrants(
  seats: SeatedUser[],
  mode: RoomPkMode,
  sidesBySeat?: Record<string, unknown> | null,
): RoomPkEntrant[] {
  const ordered = [...seats].sort((a, b) => a.seatNumber - b.seatNumber);
  if (ordered.length < ROOM_PK_MIN_PARTICIPANTS) {
    throw new BadRequestException(`At least ${ROOM_PK_MIN_PARTICIPANTS} people must be seated to start a Room PK`);
  }
  if (mode === 'INDIVIDUAL') return ordered.map((s) => ({ ...s, side: null }));

  const entrants = ordered.map((s, i): RoomPkEntrant => {
    if (!sidesBySeat) return { ...s, side: i % 2 === 0 ? 'A' : 'B' };
    const raw = sidesBySeat[String(s.seatNumber)];
    if (raw !== 'A' && raw !== 'B') {
      throw new BadRequestException(`sides must assign seat ${s.seatNumber} to "A" or "B"`);
    }
    return { ...s, side: raw };
  });
  if (!entrants.some((e) => e.side === 'A') || !entrants.some((e) => e.side === 'B')) {
    throw new BadRequestException('Each team needs at least one seated member');
  }
  return entrants;
}

export interface ScoredEntrant {
  userId: string;
  side: string | null;
  score: bigint;
}

export interface RankedEntrant extends ScoredEntrant {
  rank: number;
}

export interface RoomPkResult {
  winnerUserId: string | null;
  winnerSide: RoomPkSide | null;
  tie: boolean;
  ranking: RankedEntrant[];
  sideTotals: { A: bigint; B: bigint } | null;
}

// Competition ranking: equal scores share a rank (1, 1, 3).
export function rankEntrants(entrants: ScoredEntrant[]): RankedEntrant[] {
  const sorted = [...entrants].sort((a, b) => (a.score === b.score ? 0 : a.score > b.score ? -1 : 1));
  const out: RankedEntrant[] = [];
  sorted.forEach((e, i) => {
    const prev = out[i - 1];
    out.push({ ...e, rank: prev && prev.score === e.score ? prev.rank : i + 1 });
  });
  return out;
}

// INDIVIDUAL: the single highest score wins. TEAMS: the side with the larger pooled total wins.
// A tie for first (including 0-0, when nobody was gifted anything) has no winner.
export function decideRoomPkResult(mode: RoomPkMode, entrants: ScoredEntrant[]): RoomPkResult {
  const ranking = rankEntrants(entrants);
  if (mode === 'TEAMS') {
    let a = 0n;
    let b = 0n;
    for (const e of entrants) {
      if (e.side === 'A') a += e.score;
      else if (e.side === 'B') b += e.score;
    }
    const winnerSide: RoomPkSide | null = a === b ? null : a > b ? 'A' : 'B';
    return { winnerUserId: null, winnerSide, tie: winnerSide === null, ranking, sideTotals: { A: a, B: b } };
  }
  const top = ranking[0];
  const contenders = ranking.filter((r) => r.score === top?.score);
  const unique = top && top.score > 0n && contenders.length === 1;
  return { winnerUserId: unique ? top.userId : null, winnerSide: null, tie: !unique, ranking, sideTotals: null };
}
