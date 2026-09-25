import { randomInt } from 'crypto';

/**
 * Draws one uniform digit in [0, 9] using Node's CSPRNG
 * (crypto.randomInt, which is rejection-sampled and unbiased).
 */
export function drawDigit(): number {
  return randomInt(0, 10);
}

/** Draws the three digits for one round. */
export function drawDigits(): [number, number, number] {
  return [drawDigit(), drawDigit(), drawDigit()];
}

/** Draws a round and returns both the digits and their sum (the number that decides the round). */
export function drawRound(): { digits: [number, number, number]; sum: number } {
  const digits = drawDigits();
  return { digits, sum: digits[0] + digits[1] + digits[2] };
}
