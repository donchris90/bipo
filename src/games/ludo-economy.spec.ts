import { hasSufficientSpendableGameBalance } from './ludo.service';

describe('Ludo spendable game balance', () => {
  it('accepts BONUS + COIN together', () => {
    expect(hasSufficientSpendableGameBalance(70n, 30n, 100)).toBe(true);
  });

  it('accepts a stake funded entirely by BONUS', () => {
    expect(hasSufficientSpendableGameBalance(0n, 500n, 100)).toBe(true);
  });

  it('rejects when the combined spendable balance is insufficient', () => {
    expect(hasSufficientSpendableGameBalance(40n, 30n, 100)).toBe(false);
  });
});
