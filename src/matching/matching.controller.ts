import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { MatchingService } from './matching.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';

interface AuthedRequest extends Request {
  user: { userId: string };
}

@Controller('api/v1/match')
@UseGuards(JwtAuthGuard)
export class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  // Enter the queue (and leave any match you are currently in). Tightly rate-limited: joining
  // repeatedly is the way to hammer the pairing query.
  @Post('join')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  join(@Body('sameCountryOnly') sameCountryOnly: unknown, @Req() req: AuthedRequest) {
    return this.matching.join(req.user.userId, sameCountryOnly === true);
  }

  // Polled while searching. Kept out of the strict limiter on purpose: a normal search polls
  // every couple of seconds.
  @Get('status')
  status(@Req() req: AuthedRequest) {
    return this.matching.status(req.user.userId);
  }

  @Post('cancel')
  cancel(@Req() req: AuthedRequest) {
    return this.matching.cancel(req.user.userId);
  }

  @Get('sessions/:id')
  sessionState(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.matching.sessionState(id, req.user.userId);
  }

  @Post('sessions/:id/token')
  token(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.matching.joinToken(id, req.user.userId);
  }

  @Post('sessions/:id/like')
  like(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.matching.like(id, req.user.userId);
  }

  @Post('sessions/:id/end')
  end(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.matching.end(id, req.user.userId);
  }
}
