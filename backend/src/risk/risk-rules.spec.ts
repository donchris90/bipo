import { evaluateWithdrawalRisk } from './risk-rules';

const BASELINE = {
  accountAgeDays: 90,
  kycVerified: true,
  withdrawalsLast24h: 0,
  amountCoins: 1000,
  lifetimeEarnedCoins: 10000,
  chargebackCount: 0,
  sharedIpAccountCount: 0,
};

describe('evaluateWithdrawalRisk', () => {
  it('auto-approves a small withdrawal from an established, KYC-verified account', () => {
    const result = evaluateWithdrawalRisk(BASELINE);
    expect(result.needsReview).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('flags a new account regardless of other factors', () => {
    const result = evaluateWithdrawalRisk({ ...BASELINE, accountAgeDays: 2 });
    expect(result.needsReview).toBe(true);
    expect(result.reasons).toContain('new_account');
  });

  it('flags an unverified account withdrawing above the free limit, but not below it', () => {
    const above = evaluateWithdrawalRisk({ ...BASELINE, kycVerified: false, amountCoins: 6000 });
    expect(above.reasons).toContain('kyc_not_verified');

    const below = evaluateWithdrawalRisk({ ...BASELINE, kycVerified: false, amountCoins: 1000 });
    expect(below.reasons).not.toContain('kyc_not_verified');
  });

  it('flags high withdrawal velocity', () => {
    const result = evaluateWithdrawalRisk({ ...BASELINE, withdrawalsLast24h: 3 });
    expect(result.reasons).toContain('high_withdrawal_velocity');
  });

  it('flags a large absolute amount regardless of history', () => {
    const result = evaluateWithdrawalRisk({ ...BASELINE, amountCoins: 200_000, lifetimeEarnedCoins: 500_000 });
    expect(result.reasons).toContain('large_amount');
  });

  it('flags a near-total cashout from a young account, but not from an established one', () => {
    const young = evaluateWithdrawalRisk({
      ...BASELINE,
      accountAgeDays: 10,
      amountCoins: 9500,
      lifetimeEarnedCoins: 10000,
    });
    expect(young.reasons).toContain('near_total_earnings_new_account');

    const established = evaluateWithdrawalRisk({
      ...BASELINE,
      accountAgeDays: 200,
      amountCoins: 9500,
      lifetimeEarnedCoins: 10000,
    });
    expect(established.reasons).not.toContain('near_total_earnings_new_account');
  });

  it('does not divide by zero when lifetime earnings are zero', () => {
    expect(() => evaluateWithdrawalRisk({ ...BASELINE, lifetimeEarnedCoins: 0 })).not.toThrow();
    const result = evaluateWithdrawalRisk({ ...BASELINE, lifetimeEarnedCoins: 0 });
    expect(result.reasons).not.toContain('near_total_earnings_new_account');
  });

  it('can accumulate multiple reasons at once', () => {
    const result = evaluateWithdrawalRisk({
      accountAgeDays: 1,
      kycVerified: false,
      withdrawalsLast24h: 5,
      amountCoins: 500_000,
      lifetimeEarnedCoins: 500_000,
      chargebackCount: 0,
      sharedIpAccountCount: 0,
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining(['new_account', 'kyc_not_verified', 'high_withdrawal_velocity', 'large_amount']),
    );
  });

  it('flags any history of chargebacks, even a single one', () => {
    const result = evaluateWithdrawalRisk({ ...BASELINE, chargebackCount: 1 });
    expect(result.reasons).toContain('chargeback_history');
  });

  it('flags 3+ other accounts sharing the withdrawing user\'s recent IP, but not fewer', () => {
    const below = evaluateWithdrawalRisk({ ...BASELINE, sharedIpAccountCount: 2 });
    expect(below.reasons).not.toContain('shared_ip_multiple_accounts');

    const atThreshold = evaluateWithdrawalRisk({ ...BASELINE, sharedIpAccountCount: 3 });
    expect(atThreshold.reasons).toContain('shared_ip_multiple_accounts');
  });
});
