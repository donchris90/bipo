import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { BadgesService } from './badges.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

interface AuthedRequest extends Request {
  user: { userId: string };
}

@Controller('api/v1/badges')
@UseGuards(JwtAuthGuard)
export class BadgesController {
  constructor(private readonly badges: BadgesService) {}

  // The full catalog (including not-yet-earned badges, so the app can show them greyed out as
  // something to aim for) plus this user's earned/earnedAt state for each.
  @Get('me')
  async myBadges(@Req() req: AuthedRequest) {
    // Opportunistic: a visit to this screen is as good a moment as any to check for anything
    // newly earned, without needing a dedicated hook in every place a badge condition could
    // become true.
    await this.badges.evaluateAndAward(req.user.userId);
    return this.badges.myBadges(req.user.userId);
  }
}
