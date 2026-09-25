import { BadRequestException, Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.service';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { planStakes, LuckyNumberConfig } from './lucky-number-math';

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
  constructor(private readonly prisma: PrismaService) {}

  // Read-only: this never touches a wallet or a round. Its only job is
  // telling the client what stakes correspond to a set of picks and an
  // optional target total — actual bet placement re-derives the same
  // numbers server-side in EntryService.place() from rulesJson at that
  // moment, never trusting whatever the client echoes back here. Reading
  // rulesJson live (rather than a hard-coded config) means an admin
  // changing the RTP or base prize is reflected immediately, and can never
  // drift out of sync with what settlement actually pays — see
  // game-rules.ts, which is where rtp/basePrize are validated and where
  // numberPayouts gets derived from them using this same math module.
  @Throttle({ default: { limit: 30, ttl: 10_000 } })
  @Get(':gameCode/suggested-stakes')
  async getSuggestedStakes(
    @Param('gameCode') gameCode: string,
    @Query('numbers') numbersParam: string,
    @Query('total') totalParam?: string,
  ) {
    if (!numbersParam) throw new BadRequestException('numbers query param is required, e.g. ?numbers=7,13,20');
    const selected = parseNumberList(numbersParam);
    const requestedTotal = totalParam != null ? Number(totalParam) : undefined;
    if (requestedTotal != null && (!Number.isFinite(requestedTotal) || requestedTotal <= 0)) {
      throw new BadRequestException('total must be a positive number');
    }

    const game = await this.prisma.gameDefinition.findUnique({ where: { code: gameCode } });
    const rules = (game?.rulesJson ?? {}) as Partial<LuckyNumberConfig> & { rtp?: number };
    if (!game || typeof rules.rtp !== 'number') {
      throw new NotFoundException(`${gameCode} is not configured as an RTP-mode game`);
    }
    const config: LuckyNumberConfig = {
      rtp: rules.rtp,
      basePrize: rules.basePrize ?? 1000,
      minStake: rules.minStake ?? 1,
      maxStake: rules.maxStake ?? 1_000_000_000,
      stakeWeightExponent: rules.stakeWeightExponent ?? 1,
    };

    const { stakes, multipliers, total } = planStakes(selected, config, requestedTotal);
    return {
      rtp: config.rtp,
      basePrize: config.basePrize,
      minStake: config.minStake,
      maxStake: config.maxStake,
      multipliers: Object.fromEntries(multipliers),
      stakes: Object.fromEntries(stakes),
      total,
    };
  }
}
