import { calculateLudoPrizeSplit, calculateSpectatorPoolSplit, calculateWinningSpectatorReward } from './ludo-payout';
describe('Ludo payout rules', () => {
  it('2-player pays only first place', () => expect(calculateLudoPrizeSplit(200, 2)).toEqual({ first: 200, second: 0, platform: 0 }));
  it('4-player pays first and second 2/3 and 1/3', () => expect(calculateLudoPrizeSplit(360, 4)).toEqual({ first: 240, second: 120, platform: 0 }));
  it('splits spectator pool 10/20/70', () => expect(calculateSpectatorPoolSplit(1000)).toEqual({ platform: 100, winner: 200, spectators: 700 }));
  it('distributes winning spectator pool proportionally', () => expect(calculateWinningSpectatorReward(700, 100, 500)).toBe(140));
});
