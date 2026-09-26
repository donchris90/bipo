import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { MissionsService } from './missions.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { JourneyTierKey } from './journey-tiers';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

const TIER_KEYS: JourneyTierKey[] = ['HALFWAY', 'ALL'];

// Missions are two audiences under one roof:
//  - the Rryda Journey (creatorOnly = false): open to every signed-in user.
//  - the original creator programme (creatorOnly = true): still requires the CREATOR role,
//    filtered server-side in MissionsService.list() / enforced again in claim() below — a
//    non-creator can't unlock those missions just by knowing a mission id.
@Controller('api/v1/missions')
@UseGuards(JwtAuthGuard)
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  // Today's missions (Journey + creator, as applicable) with live progress and claim state.
  @Get()
  list(@Req() req: AuthedRequest) {
    return this.missions.list(req.user.userId, req.user.roles.includes(RoleName.CREATOR));
  }

  @Post(':id/claim')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  claim(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.missions.claim(req.user.userId, req.user.roles.includes(RoleName.CREATOR), id);
  }

  // Claims a Rryda Journey chest ("complete 3 -> Daily Chest", "complete 5 -> Perfect Day").
  @Post('journey/claim')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  claimJourneyTier(@Body('tier') tier: unknown, @Req() req: AuthedRequest) {
    if (typeof tier !== 'string' || !TIER_KEYS.includes(tier as JourneyTierKey)) {
      throw new BadRequestException('Invalid Journey tier');
    }
    return this.missions.claimTier(req.user.userId, tier as JourneyTierKey);
  }
}
