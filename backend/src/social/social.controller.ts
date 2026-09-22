import { Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { SocialService } from './social.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/social')
@UseGuards(JwtAuthGuard)
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Post('follow/:userId')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  follow(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.social.follow(req.user.userId, userId);
  }

  @Delete('follow/:userId')
  unfollow(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.social.unfollow(req.user.userId, userId);
  }

  @Post('block/:userId')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  block(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.social.block(req.user.userId, userId);
  }

  @Delete('block/:userId')
  unblock(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.social.unblock(req.user.userId, userId);
  }

  @Post('mute/:userId')
  mute(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.social.mute(req.user.userId, userId);
  }

  @Delete('mute/:userId')
  unmute(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.social.unmute(req.user.userId, userId);
  }

  @Get('stats')
  getStats(@Req() req: AuthedRequest) {
    return this.social.getStats(req.user.userId);
  }

  @Get('blocked')
  listBlocked(@Req() req: AuthedRequest) {
    return this.social.listBlocked(req.user.userId);
  }

  @Get('following')
  following(@Req() req: AuthedRequest) {
    return this.social.listFollowing(req.user.userId);
  }

  @Get('followers')
  followers(@Req() req: AuthedRequest) {
    return this.social.listFollowers(req.user.userId);
  }
}
