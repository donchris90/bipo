import { pkPointsForCoins, pkSideForRecipient } from './pk-score';

describe('Team PK score primitives', () => {
  it('keeps normal PK recipient-side behavior unchanged', () => {
    const battle = { challengerId: 'A', opponentId: 'B' };
    expect(pkSideForRecipient(battle, 'A')).toBe('CHALLENGER');
    expect(pkSideForRecipient(battle, 'B')).toBe('OPPONENT');
    expect(pkSideForRecipient(battle, 'C')).toBeNull();
  });

  it('uses the same coin-to-point conversion for advanced PK', () => {
    expect(pkPointsForCoins(1000, 10)).toBe(100n);
  });
});
