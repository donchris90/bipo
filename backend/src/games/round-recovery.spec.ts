import { planRoundRecovery, GRACE_MS, VOID_AFTER_MS, ABANDON_AFTER_MS } from './round-recovery';

const T0 = 1_800_000_000_000;
const at = (ms: number) => new Date(T0 + ms);
const dice = { isCrash: false, crashAt: null };

// A round that opened at T0 and locks 15s later.
const round = (status: string) => ({ status, openAt: at(0), lockAt: at(15_000) });

describe('planRoundRecovery — normal rounds', () => {
  it('does nothing while a round is on schedule', () => {
    expect(planRoundRecovery(round('SCHEDULED'), dice, T0 + 100)).toBe('none');
    expect(planRoundRecovery(round('OPEN'), dice, T0 + 10_000)).toBe('none');
  });

  it('leaves the first moment after a due time to the queue worker', () => {
    expect(planRoundRecovery(round('OPEN'), dice, T0 + 15_000 + GRACE_MS - 1)).toBe('none');
    expect(planRoundRecovery(round('SCHEDULED'), dice, T0 + GRACE_MS - 1)).toBe('none');
  });

  it('opens a SCHEDULED round whose open job never ran', () => {
    expect(planRoundRecovery(round('SCHEDULED'), dice, T0 + GRACE_MS)).toBe('open');
  });

  it('locks an OPEN round past its lock time', () => {
    expect(planRoundRecovery(round('OPEN'), dice, T0 + 15_000 + GRACE_MS)).toBe('lock');
  });

  it('settles a LOCKED non-crash round', () => {
    expect(planRoundRecovery(round('LOCKED'), dice, T0 + 15_000 + GRACE_MS)).toBe('settle');
  });

  it('never touches finished rounds', () => {
    expect(planRoundRecovery(round('SETTLED'), dice, T0 + 9e9)).toBe('none');
    expect(planRoundRecovery(round('CANCELLED'), dice, T0 + 9e9)).toBe('none');
  });
});

describe('planRoundRecovery — outages', () => {
  it('voids (refunds) rounds left overdue beyond the limit instead of settling them late', () => {
    const late = T0 + 15_000 + VOID_AFTER_MS + 1;
    expect(planRoundRecovery(round('SCHEDULED'), dice, late)).toBe('void');
    expect(planRoundRecovery(round('OPEN'), dice, late)).toBe('void');
    expect(planRoundRecovery(round('LOCKED'), dice, late)).toBe('void');
  });

  it('still settles a round that is only slightly overdue', () => {
    expect(planRoundRecovery(round('LOCKED'), dice, T0 + 15_000 + VOID_AFTER_MS - 1)).toBe('settle');
  });

  it('abandons (never refunds) a round stuck mid-payout', () => {
    expect(planRoundRecovery(round('RESOLVING'), dice, T0 + 15_000 + 1000)).toBe('none');
    expect(planRoundRecovery(round('RESOLVING'), dice, T0 + 15_000 + ABANDON_AFTER_MS + 1)).toBe('abandon');
  });
});

describe('planRoundRecovery — crash rounds', () => {
  // Locks at +15s, crashes 12s later.
  const crash = { isCrash: true, crashAt: at(27_000) };

  it('waits for the crash time, not the lock time', () => {
    expect(planRoundRecovery(round('LOCKED'), crash, T0 + 20_000)).toBe('none');
  });

  it('settles once the crash time has passed', () => {
    expect(planRoundRecovery(round('LOCKED'), crash, T0 + 27_000 + GRACE_MS)).toBe('settle_crash');
  });

  it('voids a crash round left overdue by an outage (players could not cash out)', () => {
    expect(planRoundRecovery(round('LOCKED'), crash, T0 + 27_000 + VOID_AFTER_MS + 1)).toBe('void');
  });

  it('never settles a crash round with no known crash point; it can only be voided', () => {
    const unknown = { isCrash: true, crashAt: null };
    expect(planRoundRecovery(round('LOCKED'), unknown, T0 + 16_000)).toBe('none');
    expect(planRoundRecovery(round('LOCKED'), unknown, T0 + 15_000 + VOID_AFTER_MS + 1)).toBe('void');
  });
});
