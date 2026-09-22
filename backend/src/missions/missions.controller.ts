import { Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { MissionsService } from './missions.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

// Missions are a creator programme: progress is measured on hosting
// activity, and rewards are paid out, so both reading and claiming require
// the CREATOR role.
function assertCreator(req: AuthedRequest) {
  if (!req.user.roles.includes(RoleName.CREATOR)) {
    throw new ForbiddenException('Missions are available to approved creators');
  }
}

@Controller('api/v1/missions')
@UseGuards(JwtAuthGuard)
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  // Today's missions with live progress and claim state.
  @Get()
  list(@Req() req: AuthedRequest) {
    assertCreator(req);
    return this.missions.list(req.user.userId);
  }

  @Post(':id/claim')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  claim(@Param('id') id: string, @Req() req: AuthedRequest) {
    assertCreator(req);
    return this.missions.claim(req.user.userId, id);
  }
}
