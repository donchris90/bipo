import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { planStakes, LuckyNumberConfig } from './lucky-number-math';

// Server-authoritative config for this game. In practice this should come
// from GameDefinition.rulesJson (the same admin-editable config path
// game-rules.ts validates for dice/crash/ludo), loaded per-request rather
// than hard-coded — left as a plain constant here since wiring a new
// GameRules shape into that validator is a config-schema change outside
// this file's scope, not a math change.
const LUCKY_NUMBER_CONFIG: LuckyNumberConfig = {
  rtp: 0.95,
  basePrize: 1000,
  minStake: 10,
  maxStake: 500_000,
};

function parseNumberList(raw: string): number[] {
  const numbers = raw.split(',').map((s) => Number(s.trim()));
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 27)) {
    throw new BadRequestException('numbers must be a comma-separated list of integers from 0 to 27');
  }
  return [...new Set(numbers)];
}

@Controller('games/lucky-number')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class LuckyNumberController {
  // Read-only: this never touches a wallet or a round. Its only job is
  // telling the client what stakes correspond to a set of picks and an
  // optional target total — actual bet placement/validation happens
  // server-side in EntryService against this same planStakes(), never
  // trusting whatever the client echoes back.
  @Throttle({ default: { limit: 30, ttl: 10_000 } })
  @Get('suggested-stakes')
  getSuggestedStakes(@Query('numbers') numbersParam: string, @Query('total') totalParam?: string) {
    if (!numbersParam) throw new BadRequestException('numbers query param is required, e.g. ?numbers=7,13,20');
    const selected = parseNumberList(numbersParam);
    const requestedTotal = totalParam != null ? Number(totalParam) : undefined;
    if (requestedTotal != null && (!Number.isFinite(requestedTotal) || requestedTotal <= 0)) {
      throw new BadRequestException('total must be a positive number');
    }

    const { stakes, total } = planStakes(selected, LUCKY_NUMBER_CONFIG, requestedTotal);
    return {
      rtp: LUCKY_NUMBER_CONFIG.rtp,
      basePrize: LUCKY_NUMBER_CONFIG.basePrize,
      minStake: LUCKY_NUMBER_CONFIG.minStake,
      maxStake: LUCKY_NUMBER_CONFIG.maxStake,
      stakes: Object.fromEntries(stakes),
      total,
    };
  }
}
