// The "Big/Small/Odd/Even" numbers game: 3 dice (0-9 each) are drawn and
// summed to a single winning number in [0, (diceSides-1)*diceCount]. A
// player picks any subset of possible sums; their stake splits evenly
// across their picks, and only the picks matching the actual sum pay out —
// this is meaningfully different from games/settlement.ts's Lucky Number,
// which requires an exact full-set match against a multi-number draw.
//
// S/B/E/O buttons in the client are just bulk-selectors over this same
// number range (S = 0..half-1, B = half..max, O/E = parity) — the backend
// only ever sees the resulting set of selected numbers, never which
// shortcut (if any) produced it.

export interface DiceConfig {
  diceCount: number; // e.g. 3
  diceSides: number; // e.g. 10 (values 0..9 per die)
}

export function maxSum(config: DiceConfig): number {
  return config.diceCount * (config.diceSides - 1);
}

export function rollDice(config: DiceConfig, roll: () => number): { dice: number[]; sum: number } {
  const dice = Array.from({ length: config.diceCount }, () => roll());
  return { dice, sum: dice.reduce((a, b) => a + b, 0) };
}

export function validateSelection(selection: unknown, maxSumValue: number): { valid: boolean; error?: string } {
  if (!Array.isArray(selection) || selection.length === 0) {
    return { valid: false, error: 'Selection must be a non-empty array of numbers' };
  }
  for (const n of selection) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > maxSumValue) {
      return { valid: false, error: `Each selection must be an integer between 0 and ${maxSumValue}` };
    }
  }
  if (new Set(selection).size !== selection.length) {
    return { valid: false, error: 'Selection must not contain duplicates' };
  }
  return { valid: true };
}

export function isWinningNumber(selection: number[], winningSum: number): boolean {
  return selection.includes(winningSum);
}

// Stake splits evenly across the player's selections (floor division — any
// remainder from an uneven split is lost to rounding, not paid out, same
// "never invent coins" principle as computeGiftSplit). Only pays if the
// winning sum is among the selections; otherwise the whole stake is lost,
// same as any other losing bet.
export function computeSumDiceReward(
  totalStake: number,
  selectionCount: number,
  payoutMultiplier: number,
  won: boolean,
): number {
  if (!won) return 0;
  const stakePerNumber = Math.floor(totalStake / selectionCount);
  return stakePerNumber * payoutMultiplier;
}

// Small/Big and Odd/Even labels — confirmed against the real app as an
// even split (0-13 Small, 14-27 Big for the default 3d10 config), not
// inferred. Generalized to maxSum so it still makes sense if diceCount/
// diceSides are ever reconfigured.
export function classifyResult(sum: number, maxSum: number): { size: 'S' | 'B'; parity: 'E' | 'O' } {
  const smallCeiling = Math.ceil((maxSum + 1) / 2); // 28 possible values (0..27) split evenly at 14
  return {
    size: sum < smallCeiling ? 'S' : 'B',
    parity: sum % 2 === 0 ? 'E' : 'O',
  };
}

// Mirrors computeSumDiceReward's exact floor-division split, so the
// displayed "pool per number" is an accurate preview of what a winning
// entry would actually be paid — not an approximation computed a
// different way that could drift from the real payout math.
export function computePerNumberPool(entries: Array<{ selection: number[]; coinAmount: number }>): Map<number, number> {
  const pool = new Map<number, number>();
  for (const entry of entries) {
    if (entry.selection.length === 0) continue;
    const perNumber = Math.floor(entry.coinAmount / entry.selection.length);
    for (const n of entry.selection) {
      pool.set(n, (pool.get(n) ?? 0) + perNumber);
    }
  }
  return pool;
}
