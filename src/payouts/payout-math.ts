import { BadRequestException } from '@nestjs/common';

// All cash arithmetic for withdrawals lives here, pure and integer-only, so it
// has direct tests and the mobile app never re-implements it (it asks the
// server for a quote instead).

export interface PayoutRules {
  minorPer100Coins: number;
  minWithdrawalCoins: number;
  maxWithdrawalCoins: number | null;
  feeBps: number;
  feeFlatMinor: number;
}

export interface PayoutQuote {
  coins: number;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  rateMinorPer100Coins: number;
}

// gross = coins * rate / 100 (rounded DOWN — a payout never rounds in the
// platform's disfavour), fee = gross * feeBps / 10000 (rounded UP — never
// under-charges) + flat, net = gross - fee.
export function computePayout(coins: number, rules: PayoutRules): PayoutQuote {
  const grossMinor = Math.floor((coins * rules.minorPer100Coins) / 100);
  const percentFee = Math.ceil((grossMinor * rules.feeBps) / 10_000);
  const feeMinor = Math.min(grossMinor, percentFee + rules.feeFlatMinor);
  return { coins, grossMinor, feeMinor, netMinor: grossMinor - feeMinor, rateMinorPer100Coins: rules.minorPer100Coins };
}

// Quote for a real request: enforces the admin's limits and refuses a payout
// that would leave nothing after fees.
export function quoteWithdrawal(coins: number, rules: PayoutRules): PayoutQuote {
  if (!Number.isInteger(coins) || coins <= 0) throw new BadRequestException('Amount must be a positive whole number of coins');
  if (coins < rules.minWithdrawalCoins) {
    throw new BadRequestException(`The minimum withdrawal is ${rules.minWithdrawalCoins.toLocaleString('en-US')} coins`);
  }
  if (rules.maxWithdrawalCoins !== null && coins > rules.maxWithdrawalCoins) {
    throw new BadRequestException(`The maximum withdrawal is ${rules.maxWithdrawalCoins.toLocaleString('en-US')} coins`);
  }
  const quote = computePayout(coins, rules);
  if (quote.netMinor <= 0) throw new BadRequestException('This amount is too small to pay out after fees');
  return quote;
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export interface PayoutConfigInput extends PayoutRules {
  enabled: boolean;
  // Must the person have passed identity verification to withdraw? On unless an admin turns it off.
  requireKyc: boolean;
  maxDailyWithdrawalCoins?: number | null;
  maxMonthlyWithdrawalCoins?: number | null;
  manualReviewAboveCoins?: number | null;
  cooldownHours?: number;
  allowedProviders?: string[] | null;
}

// Validates what an admin submits. Returns clean values or throws a 400 that
// names the field.
export function validatePayoutConfig(raw: any): PayoutConfigInput {
  if (!raw || typeof raw !== 'object') throw new BadRequestException('Body is required');
  const errors: string[] = [];
  if (typeof raw.enabled !== 'boolean') errors.push('enabled must be true or false');
  if (raw.requireKyc !== undefined && typeof raw.requireKyc !== 'boolean') errors.push('requireKyc must be true or false');
  for (const [key, label, max] of [['maxDailyWithdrawalCoins', 'maxDailyWithdrawalCoins', 2_000_000_000], ['maxMonthlyWithdrawalCoins', 'maxMonthlyWithdrawalCoins', 10_000_000_000], ['manualReviewAboveCoins', 'manualReviewAboveCoins', 10_000_000_000]] as const) {
    const v = raw[key];
    if (v !== undefined && v !== null && v !== '' && (!Number.isInteger(v) || v < 1 || v > max)) errors.push(`${label} must be empty or a positive whole number`);
  }
  if (raw.cooldownHours !== undefined && (!Number.isInteger(raw.cooldownHours) || raw.cooldownHours < 0 || raw.cooldownHours > 168)) errors.push('cooldownHours must be a whole number from 0 to 168');
  if (raw.allowedProviders !== undefined && raw.allowedProviders !== null && (!Array.isArray(raw.allowedProviders) || raw.allowedProviders.some((v: any) => !['PAYSTACK','CRYPTO','C2C','BANK'].includes(String(v).toUpperCase())))) errors.push('allowedProviders contains an unsupported provider');
  if (!isInt(raw.minorPer100Coins, 1, 100_000_000)) errors.push('minorPer100Coins must be a whole number of at least 1');
  if (!isInt(raw.minWithdrawalCoins, 1, 1_000_000_000)) errors.push('minWithdrawalCoins must be a whole number of at least 1');
  const max = raw.maxWithdrawalCoins === undefined || raw.maxWithdrawalCoins === null || raw.maxWithdrawalCoins === '' ? null : raw.maxWithdrawalCoins;
  if (max !== null && !isInt(max, 1, 2_000_000_000)) errors.push('maxWithdrawalCoins must be empty or a whole number');
  if (!isInt(raw.feeBps ?? 0, 0, 5000)) errors.push('feeBps must be between 0 and 5000 (50%)');
  if (!isInt(raw.feeFlatMinor ?? 0, 0, 100_000_000)) errors.push('feeFlatMinor must be a whole number of 0 or more');
  if (errors.length) throw new BadRequestException(errors.join('; '));
  if (max !== null && max < raw.minWithdrawalCoins) throw new BadRequestException('maxWithdrawalCoins cannot be below minWithdrawalCoins');

  const clean: PayoutConfigInput = {
    enabled: raw.enabled,
    requireKyc: raw.requireKyc ?? true,
    minorPer100Coins: raw.minorPer100Coins,
    minWithdrawalCoins: raw.minWithdrawalCoins,
    maxWithdrawalCoins: max,
    feeBps: raw.feeBps ?? 0,
    feeFlatMinor: raw.feeFlatMinor ?? 0,
    maxDailyWithdrawalCoins: raw.maxDailyWithdrawalCoins == null || raw.maxDailyWithdrawalCoins === '' ? null : raw.maxDailyWithdrawalCoins,
    maxMonthlyWithdrawalCoins: raw.maxMonthlyWithdrawalCoins == null || raw.maxMonthlyWithdrawalCoins === '' ? null : raw.maxMonthlyWithdrawalCoins,
    manualReviewAboveCoins: raw.manualReviewAboveCoins == null || raw.manualReviewAboveCoins === '' ? null : raw.manualReviewAboveCoins,
    cooldownHours: raw.cooldownHours ?? 0,
    allowedProviders: raw.allowedProviders == null ? null : Array.from(new Set<string>(raw.allowedProviders.map((v: any) => String(v).toUpperCase()))),
  };
  // Catch a configuration that could never pay anyone out.
  if (computePayout(clean.minWithdrawalCoins, clean).netMinor <= 0) {
    throw new BadRequestException('At the minimum withdrawal the fees would take the whole payout — lower the fee or raise the minimum');
  }
  return clean;
}
