import { Injectable } from '@nestjs/common';
import { randomInt, randomBytes, createHash, createHmac } from 'crypto';

// Never Math.random() for anything financial (spec §41/§94). This is the
// only place a game result should be generated — RoundService calls this,
// nothing else should.
@Injectable()
export class RngService {
  // Inclusive range [min, max].
  randomInRange(min: number, max: number): number {
    return randomInt(min, max + 1);
  }

  generateSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Deterministic, cryptographically-derived integer for commit/reveal games.
   * Rejection sampling avoids modulo bias for ranges that do not divide 2^32.
   */
  randomInRangeFromSecret(secret: string, context: string, min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error('Invalid deterministic RNG range');
    }
    const range = max - min + 1;
    const UINT32 = 2 ** 32;
    const limit = Math.floor(UINT32 / range) * range;
    for (let counter = 0; counter < 1024; counter++) {
      const digest = createHmac('sha256', secret).update(`${context}:${counter}`).digest();
      const value = digest.readUInt32BE(0);
      if (value < limit) return min + (value % range);
    }
    throw new Error('Deterministic RNG failed to produce a value');
  }

  // Commit-reveal (spec §42): publish the hash before the round opens (so
  // it can't have been chosen to fit a result), reveal the secret after
  // settlement so the result can be independently recomputed and verified.
  commitmentHash(secret: string, roundData: string): string {
    return createHash('sha256').update(`${secret}:${roundData}`).digest('hex');
  }
}
