import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { OnboardingService } from './onboarding.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

interface AuthedRequest extends Request {
  user: { userId: string };
}

@Controller('api/v1/onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('interests')
  interests() {
    return this.onboarding.listInterests();
  }

  @Get('status')
  status(@Req() req: AuthedRequest) {
    return this.onboarding.status(req.user.userId);
  }

  @Post('interests')
  setInterests(@Body('interests') interests: unknown, @Req() req: AuthedRequest) {
    return this.onboarding.setInterests(req.user.userId, interests);
  }

  @Get('suggested-creators')
  suggestedCreators(@Query('limit') limit: string | undefined, @Req() req: AuthedRequest) {
    return this.onboarding.suggestedCreators(req.user.userId, limit ? Number(limit) : undefined);
  }

  @Post('complete')
  complete(@Req() req: AuthedRequest) {
    return this.onboarding.complete(req.user.userId);
  }
}
