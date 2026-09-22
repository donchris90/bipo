import { BadRequestException } from '@nestjs/common';
import { computePayout, quoteWithdrawal, validatePayoutConfig } from './payout-math';

const rules = { minorPer100Coins: 5000, minWithdrawalCoins: 1000, maxWithdrawalCoins: 100_000, feeBps: 200, feeFlatMinor: 5000 };

describe('computePayout', () => {
  it('turns coins into cash at the admin rate, in minor units', () => {
    // 1000 coins at N50 per 100 = N500.00 = 50,000 kobo
    expect(computePayout(1000, { ...rules, feeBps: 0, feeFlatMinor: 0 })).toMatchObject({ grossMinor: 50_000, feeMinor: 0, netMinor: 50_000 });
  });

  it('applies a percentage fee and a flat fee, both', () => {
    // gross 50,000; 2% = 1,000; + 5,000 flat = 6,000; net 44,000
    expect(computePayout(1000, rules)).toEqual({ coins: 1000, grossMinor: 50_000, feeMinor: 6_000, netMinor: 44_000, rateMinorPer100Coins: 5000 });
  });

  it('rounds the payout down and the fee up, so nobody is short-changed by rounding', () => {
    const q = computePayout(7, { minorPer100Coins: 333, minWithdrawalCoins: 1, maxWithdrawalCoins: null, feeBps: 150, feeFlatMinor: 0 });
    expect(q.grossMinor).toBe(23); // 7*333/100 = 23.31 -> 23
    expect(q.feeMinor).toBe(1); // 23*1.5% = 0.345 -> 1
    expect(q.netMinor).toBe(22);
  });

  it('never lets the fee exceed the gross amount', () => {
    expect(computePayout(10, { ...rules, feeFlatMinor: 999_999 }).netMinor).toBe(0);
  });
});

describe('quoteWithdrawal', () => {
  it('enforces the admin-set minimum and maximum', () => {
    expect(() => quoteWithdrawal(999, rules)).toThrow(/minimum withdrawal is 1,000/);
    expect(() => quoteWithdrawal(100_001, rules)).toThrow(/maximum withdrawal is 100,000/);
    expect(quoteWithdrawal(1000, rules).netMinor).toBe(44_000);
  });

  it('no maximum when it is not set', () => {
    expect(quoteWithdrawal(5_000_000, { ...rules, maxWithdrawalCoins: null }).coins).toBe(5_000_000);
  });

  it('rejects non-integers and payouts eaten entirely by fees', () => {
    expect(() => quoteWithdrawal(1.5, rules)).toThrow(BadRequestException);
    expect(() => quoteWithdrawal(1000, { ...rules, feeFlatMinor: 60_000 })).toThrow(/too small/);
  });
});

describe('validatePayoutConfig', () => {
  const good = { enabled: true, minorPer100Coins: 5000, minWithdrawalCoins: 1000, maxWithdrawalCoins: null, feeBps: 100, feeFlatMinor: 0 };

  it('accepts a sensible config and defaults fees to zero', () => {
    expect(validatePayoutConfig(good)).toMatchObject({ enabled: true, feeBps: 100, maxWithdrawalCoins: null });
    expect(validatePayoutConfig({ ...good, feeBps: undefined, feeFlatMinor: undefined })).toMatchObject({ feeBps: 0, feeFlatMinor: 0 });
  });

  it('names what is wrong', () => {
    expect(() => validatePayoutConfig({ ...good, minorPer100Coins: 0 })).toThrow(/minorPer100Coins/);
    expect(() => validatePayoutConfig({ ...good, minorPer100Coins: 12.5 })).toThrow(/minorPer100Coins/);
    expect(() => validatePayoutConfig({ ...good, feeBps: 6000 })).toThrow(/feeBps/);
    expect(() => validatePayoutConfig({ ...good, enabled: 'yes' })).toThrow(/enabled/);
    expect(() => validatePayoutConfig({ ...good, maxWithdrawalCoins: 500 })).toThrow(/cannot be below/);
    expect(() => validatePayoutConfig(null)).toThrow(BadRequestException);
  });

  it('refuses a config where fees would swallow the minimum payout', () => {
    expect(() => validatePayoutConfig({ ...good, feeFlatMinor: 60_000 })).toThrow(/fees would take the whole payout/);
  });
});
