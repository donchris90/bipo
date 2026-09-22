// Crash game (spec §44-46). The one non-negotiable from §46: the client
// never determines crash_point, current_multiplier, or a cashout result —
// every function here is what the server uses to be the sole authority on
// all three.

// The random input (an integer, e.g. from RngService.randomInRange) is
// converted to r in (0,1) exclusive on both ends — never exactly 0 (would
// make crashPoint negative/undefined-ish below 1) or exactly 1 (division
// by zero).
const CRASH_RANDOM_RANGE = 2 ** 32;

export function randomIntToUnitInterval(randomInt: number): number {
  return randomInt / CRASH_RANDOM_RANGE;
}

// crashPoint = (1 - houseEdge) / (1 - r). This specific formula (not just
// "any distribution that looks Pareto-like") is chosen because it has a
// clean, provable property: for a player following the fixed strategy
// "always try to cash out at multiplier m", the expected return is exactly
// (1 - houseEdge) regardless of m — the house edge doesn't depend on which
// cash-out target a player picks. floor()'ing to the cent adds a hair of
// extra edge beyond the nominal parameter, which is standard practice (the
// displayed crash point should never overstate what was actually
// reachable).
export function generateCrashPoint(randomInt: number, houseEdge: number): number {
  const r = randomIntToUnitInterval(randomInt);
  const raw = (1 - houseEdge) / (1 - r);
  return Math.max(1.0, Math.floor(raw * 100) / 100);
}

// Pure function of elapsed time — this is what makes "current multiplier"
// computable on demand with no ticking process, timer, or stored mutable
// state. floor()'d to the cent so the server-reported value is never
// ahead of what a real cash-out at this instant would actually pay.
export function currentMultiplier(elapsedSeconds: number, growthRate: number): number {
  if (elapsedSeconds <= 0) return 1.0;
  const raw = Math.exp(growthRate * elapsedSeconds);
  return Math.floor(raw * 100) / 100;
}

// Inverse of currentMultiplier — solves multiplier(t) = crashPoint for t.
// This is computed once at round creation (from the hidden crashPoint) and
// used to schedule the single job that reveals the result; it is NOT
// itself the crash point and does not need to stay hidden the same way,
// but nothing in this codebase exposes it before settlement regardless.
export function crashTimeSeconds(crashPoint: number, growthRate: number): number {
  return Math.log(crashPoint) / growthRate;
}

export interface CashoutResult {
  success: boolean;
  multiplier?: number; // only present when success is true
}

// The core of spec §46: elapsedSeconds is measured server-side from the
// round's own recorded start time, compared against the precomputed crash
// time — never a client-supplied "I cashed out at 2.5x" claim.
export function resolveCashout(elapsedSeconds: number, crashPoint: number, growthRate: number): CashoutResult {
  const crashAt = crashTimeSeconds(crashPoint, growthRate);
  if (elapsedSeconds >= crashAt) {
    return { success: false }; // the round had already crashed by this instant
  }
  // min() guards a theoretical floor()-rounding edge case where
  // currentMultiplier could compute fractionally above crashPoint for an
  // elapsedSeconds a hair under crashAt — a paid-out multiplier must never
  // exceed the actual crash point.
  const multiplier = Math.min(currentMultiplier(elapsedSeconds, growthRate), crashPoint);
  return { success: true, multiplier };
}

export interface AutoCashoutResult {
  won: boolean;
  multiplier?: number;
}

// Auto-cashout doesn't need real-time processing at all — once the final
// crashPoint is known at settlement, whether a given target would have
// been reached before the crash is a pure comparison, resolved for every
// entry in one pass rather than needing a scheduled job per entry.
// Strictly less-than: hitting exactly the crash point is the crash itself,
// not a valid cash-out an instant before it.
export function resolveAutoCashout(autoCashoutMultiplier: number, crashPoint: number): AutoCashoutResult {
  if (autoCashoutMultiplier < crashPoint) {
    return { won: true, multiplier: autoCashoutMultiplier };
  }
  return { won: false };
}

// Payout for either a manual or auto cash-out — the multiplier IS the
// payout rate here (no separate flat multiplier layer like the other two
// games), since the house edge is already baked into the crash-point
// distribution itself.
export function computeCrashReward(stake: number, cashoutMultiplier: number): number {
  return Math.floor(stake * cashoutMultiplier);
}
