// Decides what (if anything) should be done to a game round that is not in a
// terminal state, purely from its status and the clock. Kept free of any
// database or Nest imports so the rules that touch real money are unit-testable.
//
// Why this exists: round progression used to depend entirely on delayed Redis
// jobs (open -> lock -> settle). If Redis was unreachable, or lost its jobs, a
// round sat unfinished forever — and because the scheduler never opens a new
// round while one is unfinished, the whole game froze. The scheduler now
// applies this plan every second, so a game keeps moving even with no queue.

export type RoundStatusName = 'SCHEDULED' | 'OPEN' | 'LOCKED' | 'RESOLVING' | 'SETTLED' | 'CANCELLED';

export type RecoveryAction =
  | 'none'
  | 'open' // SCHEDULED and its open time has passed
  | 'lock' // OPEN and its lock time has passed
  | 'settle' // LOCKED (non-crash) and due
  | 'settle_crash' // LOCKED crash round whose crash time has passed
  | 'void' // overdue far beyond normal: cancel and refund every entry
  | 'abandon'; // RESOLVING for far too long: cannot be safely finished automatically

// The queue worker normally acts at the exact due time. Waiting this long
// first means the worker "wins" whenever it is healthy, and this only steps in
// when it did not.
export const GRACE_MS = 1000;

// A round overdue by more than this was left behind by an outage (server
// asleep, Redis lost, deploy). Settling it would decide money outcomes long
// after players saw it, and for Crash players could not cash out in time — so
// it is cancelled and every entry refunded instead.
export const VOID_AFTER_MS = 60_000;

// A round stuck in RESOLVING this long crashed partway through paying out.
// Some entries may already be paid, so it is never auto-refunded; it is only
// reported and stops blocking the game.
export const ABANDON_AFTER_MS = 5 * 60_000;

export interface RecoveryRound {
  status: RoundStatusName | string;
  openAt: Date;
  lockAt: Date;
}

export interface RecoveryContext {
  isCrash: boolean;
  // Wall-clock instant a Crash round crashes (lockAt + time-to-crash-point).
  // null when it cannot be determined (hiddenState missing).
  crashAt: Date | null;
}

export function planRoundRecovery(round: RecoveryRound, ctx: RecoveryContext, now: number): RecoveryAction {
  const lockAt = round.lockAt.getTime();
  const openAt = round.openAt.getTime();

  switch (round.status) {
    case 'SCHEDULED': {
      if (now > lockAt + VOID_AFTER_MS) return 'void';
      return now >= openAt + GRACE_MS ? 'open' : 'none';
    }
    case 'OPEN': {
      if (now > lockAt + VOID_AFTER_MS) return 'void';
      return now >= lockAt + GRACE_MS ? 'lock' : 'none';
    }
    case 'LOCKED': {
      if (ctx.isCrash) {
        // Without a crash point the round can never be settled honestly, so
        // it can only be waited out and then voided.
        if (!ctx.crashAt) return now > lockAt + VOID_AFTER_MS ? 'void' : 'none';
        const crashAt = ctx.crashAt.getTime();
        if (now > crashAt + VOID_AFTER_MS) return 'void';
        return now >= crashAt + GRACE_MS ? 'settle_crash' : 'none';
      }
      if (now > lockAt + VOID_AFTER_MS) return 'void';
      return now >= lockAt + GRACE_MS ? 'settle' : 'none';
    }
    case 'RESOLVING': {
      return now > lockAt + ABANDON_AFTER_MS ? 'abandon' : 'none';
    }
    default:
      return 'none'; // SETTLED / CANCELLED are terminal
  }
}
