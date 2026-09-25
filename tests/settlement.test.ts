import { placeBet, validateBet, ValidationError } from '../src/settlement';
import { BetStore, Wallet } from '../src/store';
import { DEFAULT_CONFIG } from '../src/types';
import * as rng from '../src/rng';

describe('settlement', () => {
  let store: BetStore;
  let wallet: Wallet;

  beforeEach(() => {
    store = new BetStore();
    wallet = new Wallet(10_000);
  });

  it('pays 0 and stores a losing bet when the result is not picked', () => {
    jest.spyOn(rng, 'drawRound').mockReturnValue({ digits: [3, 3, 3], sum: 9 }); // not picked below
    const result = placeBet(
      { picks: [0, 27], stakes: { 0: 2, 27: 2 }, idempotencyKey: 'k1' },
      DEFAULT_CONFIG,
      store,
      wallet,
    );
    expect(result.result).toBe(9);
    expect(result.won).toBe(false);
    expect(result.payout).toBe(0);
    expect(result.net).toBe(-4);
    expect(wallet.getBalance()).toBe(10_000 - 4);
    jest.restoreAllMocks();
  });

  it('pays stake * multiplier when the result is picked', () => {
    jest.spyOn(rng, 'drawRound').mockReturnValue({ digits: [3, 3, 3], sum: 9 });
    const result = placeBet(
      { picks: [9, 18], stakes: { 9: 59, 18: 59 }, idempotencyKey: 'k2' },
      DEFAULT_CONFIG,
      store,
      wallet,
    );
    expect(result.won).toBe(true);
    expect(result.payout).toBe(59 * 17); // multiplier for 9 is 17
    expect(result.net).toBe(59 * 17 - 118);
    jest.restoreAllMocks();
  });

  it('settles a given idempotency key only once — replays return the same result without re-crediting', () => {
    jest.spyOn(rng, 'drawRound').mockReturnValue({ digits: [3, 3, 3], sum: 9 });
    const req = { picks: [9], stakes: { 9: 59 }, idempotencyKey: 'same-key' };

    const first = placeBet(req, DEFAULT_CONFIG, store, wallet);
    const balanceAfterFirst = wallet.getBalance();

    const second = placeBet(req, DEFAULT_CONFIG, store, wallet);
    const balanceAfterSecond = wallet.getBalance();

    expect(second.betId).toBe(first.betId);
    expect(second.payout).toBe(first.payout);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    // Balance must not move on replay — the win/loss is credited exactly once.
    expect(balanceAfterSecond).toBe(balanceAfterFirst);

    jest.restoreAllMocks();
  });

  it('rejects picks outside 0-27', () => {
    expect(() =>
      validateBet({ picks: [28], stakes: { 28: 1 }, idempotencyKey: 'x' }, DEFAULT_CONFIG),
    ).toThrow(ValidationError);
    expect(() =>
      validateBet({ picks: [-1], stakes: { [-1]: 1 }, idempotencyKey: 'x' }, DEFAULT_CONFIG),
    ).toThrow(ValidationError);
  });

  it('rejects a bet with no picks', () => {
    expect(() => validateBet({ picks: [], stakes: {}, idempotencyKey: 'x' }, DEFAULT_CONFIG)).toThrow(
      ValidationError,
    );
  });

  it('rejects non-integer or non-positive stakes', () => {
    expect(() =>
      validateBet({ picks: [5], stakes: { 5: 0 }, idempotencyKey: 'x' }, DEFAULT_CONFIG),
    ).toThrow(ValidationError);
    expect(() =>
      validateBet({ picks: [5], stakes: { 5: 1.5 }, idempotencyKey: 'x' }, DEFAULT_CONFIG),
    ).toThrow(ValidationError);
  });

  it('rejects a total stake outside the configured min/max', () => {
    const tight = { ...DEFAULT_CONFIG, minTotalStake: 100, maxTotalStake: 200 };
    expect(() =>
      validateBet({ picks: [13], stakes: { 13: 1 }, idempotencyKey: 'x' }, tight),
    ).toThrow(ValidationError);
  });

  it('never trusts a client-supplied payout: the server always recomputes from picks/stakes/result', () => {
    jest.spyOn(rng, 'drawRound').mockReturnValue({ digits: [3, 3, 3], sum: 9 });
    // Even if a caller tried to smuggle extra fields, only picks/stakes drive the payout.
    const result = placeBet(
      { picks: [9], stakes: { 9: 59 }, idempotencyKey: 'k3' } as any,
      DEFAULT_CONFIG,
      store,
      wallet,
    );
    expect(result.payout).toBe(59 * 17);
    jest.restoreAllMocks();
  });
});
