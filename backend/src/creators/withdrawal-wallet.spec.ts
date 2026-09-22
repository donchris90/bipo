import { BadRequestException } from '@nestjs/common';
import { parseWithdrawableWallet } from './withdrawal.service';

describe('parseWithdrawableWallet', () => {
  it('defaults to the creator wallet when absent', () => {
    expect(parseWithdrawableWallet(undefined)).toBe('CREATOR_EARNINGS');
    expect(parseWithdrawableWallet(null)).toBe('CREATOR_EARNINGS');
    expect(parseWithdrawableWallet('')).toBe('CREATOR_EARNINGS');
  });

  it('accepts the two withdrawable wallets', () => {
    expect(parseWithdrawableWallet('CREATOR_EARNINGS')).toBe('CREATOR_EARNINGS');
    expect(parseWithdrawableWallet('AGENCY_EARNINGS')).toBe('AGENCY_EARNINGS');
  });

  it('rejects wallets that must never be paid out', () => {
    expect(() => parseWithdrawableWallet('COIN')).toThrow(BadRequestException);
    expect(() => parseWithdrawableWallet('BONUS')).toThrow(BadRequestException);
    expect(() => parseWithdrawableWallet('agency_earnings')).toThrow(BadRequestException);
  });
});
