import { BetResult } from './types';

/**
 * In-memory store, good enough for tests and a demo deployment.
 * Swap for a real database (with a unique constraint on idempotencyKey)
 * before running this for real money — see README "Assumptions".
 */
export class BetStore {
  private byIdempotencyKey = new Map<string, BetResult>();
  private betCounter = 0;

  /** Returns the previously-settled result for this key, if any. */
  getByIdempotencyKey(key: string): BetResult | undefined {
    return this.byIdempotencyKey.get(key);
  }

  nextBetId(): string {
    this.betCounter += 1;
    return `bet_${this.betCounter}_${Date.now()}`;
  }

  /** Records a freshly-settled result. Throws if the key was already used, to catch races. */
  save(result: BetResult): void {
    if (this.byIdempotencyKey.has(result.idempotencyKey)) {
      throw new Error(`Idempotency key already settled: ${result.idempotencyKey}`);
    }
    this.byIdempotencyKey.set(result.idempotencyKey, result);
  }

  clear(): void {
    this.byIdempotencyKey.clear();
    this.betCounter = 0;
  }
}

/**
 * A minimal in-memory wallet. There's no auth/user model in this exercise,
 * so this is a single shared balance — see README "Assumptions" for how
 * this would become per-account in a real deployment.
 */
export class Wallet {
  private balance: number;

  constructor(startingBalance = 10_000) {
    this.balance = startingBalance;
  }

  getBalance(): number {
    return this.balance;
  }

  debit(amount: number): void {
    if (amount < 0) throw new Error('debit amount must be >= 0');
    if (this.balance < amount) throw new Error('insufficient balance');
    this.balance -= amount;
  }

  credit(amount: number): void {
    if (amount < 0) throw new Error('credit amount must be >= 0');
    this.balance += amount;
  }

  reset(startingBalance = 10_000): void {
    this.balance = startingBalance;
  }
}
