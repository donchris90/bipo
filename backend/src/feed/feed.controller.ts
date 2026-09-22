import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { FeedService } from './feed.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/feed')
@UseGuards(JwtAuthGuard)
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get('following')
  following(@Req() req: AuthedRequest) {
    return this.feed.following(req.user.userId);
  }

  @Get('discover')
  discover(@Req() req: AuthedRequest) {
    return this.feed.discover(req.user.userId);
  }

  // Home's redesigned default view — real LiveSession rows, not a ranked
  // feed. See FeedService.liveNow for why this is ordered by recency
  // rather than a viewer-count/engagement score that doesn't exist yet.
  @Get('live-now')
  liveNow() {
    return this.feed.liveNow();
  }

  @Get('for-you')
  forYou(@Req() req: AuthedRequest) {
    return this.feed.forYou(req.user.userId);
  }

  @Get('new')
  newUsers(@Req() req: AuthedRequest) {
    return this.feed.newUsers(req.user.userId);
  }

  @Get('nearby')
  nearby(@Req() req: AuthedRequest) {
    return this.feed.nearby(req.user.userId, req.user.countryCode);
  }
}
