// Withdrawal risk combines account, KYC, velocity, chargeback, network and
// suspicious gifting signals. `needsReview` remains backwards-compatible:
// any material risk signal still routes the withdrawal to review. The score
// and level make the reason severity explicit for finance/admin tooling.
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RiskInput {
  accountAgeDays: number;
  kycVerified: boolean;
  withdrawalsLast24h: number;
  amountCoins: number;
  lifetimeEarnedCoins: number;
  chargebackCount: number;
  sharedIpAccountCount: number;
  sharedDeviceAccountCount?: number;
  selfGiftCountLast30d?: number;
}

export interface RiskResult {
  needsReview: boolean;
  score: number;
  level: RiskLevel;
  reasons: string[];
}

const NEW_ACCOUNT_DAYS = 7;
const MAX_WITHDRAWALS_PER_24H = 3;
const LARGE_AMOUNT_COINS = 100_000;
const UNVERIFIED_FREE_LIMIT_COINS = 5_000;
const NEAR_TOTAL_EARNINGS_RATIO = 0.9;
const SHARED_IP_ACCOUNT_THRESHOLD = 3;
const SHARED_DEVICE_ACCOUNT_THRESHOLD = 2;

function levelForScore(score: number): RiskLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 50) return 'HIGH';
  if (score >= 25) return 'MEDIUM';
  return 'LOW';
}

export function evaluateWithdrawalRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];
  let score = 0;

  if (input.accountAgeDays < NEW_ACCOUNT_DAYS) {
    reasons.push('new_account');
    score += 30;
  }
  if (!input.kycVerified && input.amountCoins > UNVERIFIED_FREE_LIMIT_COINS) {
    reasons.push('kyc_not_verified');
    score += 25;
  }
  if (input.withdrawalsLast24h >= MAX_WITHDRAWALS_PER_24H) {
    reasons.push('high_withdrawal_velocity');
    score += 25;
  }
  if (input.amountCoins > LARGE_AMOUNT_COINS) {
    reasons.push('large_amount');
    score += 20;
  }
  if (
    input.lifetimeEarnedCoins > 0 &&
    input.amountCoins / input.lifetimeEarnedCoins > NEAR_TOTAL_EARNINGS_RATIO &&
    input.accountAgeDays < 30
  ) {
    reasons.push('near_total_earnings_new_account');
    score += 25;
  }
  if (input.chargebackCount > 0) {
    reasons.push('chargeback_history');
    score += 40;
  }
  if ((input.sharedDeviceAccountCount ?? 0) >= SHARED_DEVICE_ACCOUNT_THRESHOLD) {
    reasons.push('shared_device_multiple_accounts');
    score += 25;
  }
  if (input.sharedIpAccountCount >= SHARED_IP_ACCOUNT_THRESHOLD) {
    reasons.push('shared_ip_multiple_accounts');
    score += 15;
  }
  if ((input.selfGiftCountLast30d ?? 0) > 0) {
    reasons.push('self_gifting_history');
    score += 35;
  }

  const level = levelForScore(score);
  return {
    needsReview: reasons.length > 0,
    score,
    level,
    reasons,
  };
}
