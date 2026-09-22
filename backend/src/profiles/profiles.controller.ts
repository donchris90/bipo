import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { ProfilesService } from './profiles.service';

interface AuthedRequest extends Request {
  user: { userId: string };
}

@Controller('api/v1/profiles')
@UseGuards(JwtAuthGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':userId')
  get(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.profiles.get(req.user.userId, userId);
  }

  // Called when someone opens another person's profile card.
  @Post(':userId/view')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  view(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.profiles.recordView(req.user.userId, userId);
  }
}
