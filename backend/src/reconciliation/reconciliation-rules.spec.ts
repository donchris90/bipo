import { reconcileWallet } from './reconciliation-rules';

describe('reconcileWallet', () => {
  it('is ok when balance exactly matches the ledger sum', () => {
    const result = reconcileWallet('w1', 100n, 100n);
    expect(result.ok).toBe(true);
    expect(result.discrepancy).toBe(0n);
  });

  it('is ok at zero (a never-funded wallet)', () => {
    const result = reconcileWallet('w1', 0n, 0n);
    expect(result.ok).toBe(true);
  });

  it('flags a positive discrepancy (balance higher than the ledger accounts for)', () => {
    const result = reconcileWallet('w1', 150n, 100n);
    expect(result.ok).toBe(false);
    expect(result.discrepancy).toBe(50n);
  });

  it('flags a negative discrepancy (balance lower than the ledger accounts for)', () => {
    const result = reconcileWallet('w1', 60n, 100n);
    expect(result.ok).toBe(false);
    expect(result.discrepancy).toBe(-40n);
  });

  it('handles large bigint values without precision loss', () => {
    const big = 9_007_199_254_740_993n; // beyond Number.MAX_SAFE_INTEGER
    const result = reconcileWallet('w1', big, big);
    expect(result.ok).toBe(true);
  });
});
