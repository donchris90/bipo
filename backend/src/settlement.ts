import { computeMultipliers } from './game';
import { drawRound } from './rng';
import { BetStore, Wallet } from './store';
import { BetResult, GameConfig, PlaceBetRequest, StakeMap } from './types';
import { MAX_SUM, MIN_SUM } from './probability';

export class ValidationError extends Error {}

/**
 * Validates a bet request against server-side rules. Never trust the
 * client's picks/stakes/total beyond using them as *proposed* values —
 * this is the only function that decides whether a bet is acceptable.
 */
export function validateBet(req: PlaceBetRequest, config: GameConfig): void {
  if (!req.idempotencyKey || typeof req.idempotencyKey !== 'string') {
    throw new ValidationError('idempotencyKey is required');
  }
  if (!Array.isArray(req.picks) || req.picks.length === 0) {
    throw new ValidationError('at least one number must be picked');
  }
  const seen = new Set<number>();
  for (const n of req.picks) {
    if (!Number.isInteger(n) || n < MIN_SUM || n > MAX_SUM) {
      throw new ValidationError(`pick ${n} is out of range 0-27`);
    }
    if (seen.has(n)) {
      throw new ValidationError(`duplicate pick ${n}`);
    }
    seen.add(n);
  }
  for (const n of req.picks) {
    const s = req.stakes[n];
    if (!Number.isInteger(s) || s < 1) {
      throw new ValidationError(`stake for ${n} must be a whole number >= 1`);
    }
  }
  const extraStakeKeys = Object.keys(req.stakes)
    .map(Number)
    .filter((n) => !seen.has(n));
  if (extraStakeKeys.length > 0) {
    throw new ValidationError(`stakes given for unpicked numbers: ${extraStakeKeys.join(', ')}`);
  }
  const total = req.picks.reduce((sum, n) => sum + req.stakes[n], 0);
  if (total < config.minTotalStake || total > config.maxTotalStake) {
    throw new ValidationError(
      `total stake ${total} is outside allowed range [${config.minTotalStake}, ${config.maxTotalStake}]`,
    );
  }
}

function computePayout(picks: number[], stakes: StakeMap, multipliers: number[], result: number): number {
  if (!picks.includes(result)) return 0;
  return stakes[result] * multipliers[result];
}

/**
 * Places and settles a bet in one atomic step:
 * validate -> (idempotency check) -> debit stake -> draw -> credit payout -> record.
 * A round is settled exactly once per idempotencyKey: replaying the same
 * key returns the original result without drawing again or moving coins again.
 */
export function placeBet(
  req: PlaceBetRequest,
  config: GameConfig,
  store: BetStore,
  wallet: Wallet,
): BetResult {
  const existing = store.getByIdempotencyKey(req.idempotencyKey);
  if (existing) {
    return { ...existing, replayed: true };
  }

  validateBet(req, config);

  const totalStake = req.picks.reduce((sum, n) => sum + req.stakes[n], 0);
  const multipliers = computeMultipliers(config);

  wallet.debit(totalStake);
  const { digits, sum: result } = drawRound();
  const payout = computePayout(req.picks, req.stakes, multipliers, result);
  if (payout > 0) wallet.credit(payout);

  const betResult: BetResult = {
    betId: store.nextBetId(),
    idempotencyKey: req.idempotencyKey,
    picks: req.picks,
    stakes: req.stakes,
    totalStake,
    digits,
    result,
    won: payout > 0,
    payout,
    net: payout - totalStake,
    settledAt: Date.now(),
    replayed: false,
  };

  store.save(betResult);
  return betResult;
}
