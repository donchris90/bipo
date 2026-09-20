// spec §54 lists the real inputs: account_age, KYC_status, chargebacks,
// gift_patterns, withdrawal_velocity, device/IP signals. All six are now
// covered — chargebacks and device/IP signals were the two genuinely
// missing pieces, added here rather than left as placeholders.
export interface RiskInput {
  accountAgeDays: number;
  kycVerified: boolean;
  withdrawalsLast24h: number;
  amountCoins: number;
  lifetimeEarnedCoins: number;
  chargebackCount: number;
  sharedIpAccountCount: number; // distinct other accounts seen logging in from this user's most recent IP, last 30 days
}

export interface RiskResult {
  needsReview: boolean;
  reasons: string[];
}

const NEW_ACCOUNT_DAYS = 7;
const MAX_WITHDRAWALS_PER_24H = 3;
const LARGE_AMOUNT_COINS = 100_000;
const UNVERIFIED_FREE_LIMIT_COINS = 5_000; // KYC-unverified accounts can withdraw small amounts without review; anything above needs it
const NEAR_TOTAL_EARNINGS_RATIO = 0.9;
const SHARED_IP_ACCOUNT_THRESHOLD = 3; // 3+ distinct other accounts from the same IP is a farming/collusion signal, not a household coincidence

export function evaluateWithdrawalRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];

  if (input.accountAgeDays < NEW_ACCOUNT_DAYS) reasons.push('new_account');
  if (!input.kycVerified && input.amountCoins > UNVERIFIED_FREE_LIMIT_COINS) reasons.push('kyc_not_verified');
  if (input.withdrawalsLast24h >= MAX_WITHDRAWALS_PER_24H) reasons.push('high_withdrawal_velocity');
  if (input.amountCoins > LARGE_AMOUNT_COINS) reasons.push('large_amount');
  if (
    input.lifetimeEarnedCoins > 0 &&
    input.amountCoins / input.lifetimeEarnedCoins > NEAR_TOTAL_EARNINGS_RATIO &&
    input.accountAgeDays < 30
  ) {
    reasons.push('near_total_earnings_new_account');
  }
  if (input.chargebackCount > 0) reasons.push('chargeback_history');
  if (input.sharedIpAccountCount >= SHARED_IP_ACCOUNT_THRESHOLD) reasons.push('shared_ip_multiple_accounts');

  return { needsReview: reasons.length > 0, reasons };
}
