import { Injectable } from '@nestjs/common';
import { randomInt, randomBytes, createHash } from 'crypto';

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

  // Commit-reveal (spec §42): publish the hash before the round opens (so
  // it can't have been chosen to fit a result), reveal the secret after
  // settlement so the result can be independently recomputed and verified.
  commitmentHash(secret: string, roundData: string): string {
    return createHash('sha256').update(`${secret}:${roundData}`).digest('hex');
  }
}
