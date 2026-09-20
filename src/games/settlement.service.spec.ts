import { isWinningSelection } from './settlement.service';

describe('isWinningSelection', () => {
  it('wins when the selection exactly matches the drawn result', () => {
    expect(isWinningSelection([7], [7])).toBe(true);
    expect(isWinningSelection([3, 7, 12], [12, 3, 7])).toBe(true); // order shouldn't matter
  });

  it('loses when any number differs', () => {
    expect(isWinningSelection([7], [8])).toBe(false);
    expect(isWinningSelection([3, 7, 12], [3, 7, 13])).toBe(false);
  });

  it('loses when the selection length differs from the result length', () => {
    expect(isWinningSelection([3, 7], [3, 7, 12])).toBe(false);
    expect(isWinningSelection([3, 7, 12], [3, 7])).toBe(false);
  });

  it('loses (never throws) for malformed non-array selections', () => {
    expect(isWinningSelection(null, [7])).toBe(false);
    expect(isWinningSelection(undefined, [7])).toBe(false);
    expect(isWinningSelection('7', [7])).toBe(false);
    expect(isWinningSelection({ 0: 7 }, [7])).toBe(false);
  });

  it('loses on an empty selection against a non-empty result', () => {
    expect(isWinningSelection([], [7])).toBe(false);
  });
});
