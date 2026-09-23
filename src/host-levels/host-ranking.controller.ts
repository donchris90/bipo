import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { HostRankingService } from './host-ranking.service';

interface AuthedRequest extends Request { user: { userId: string }; }

@Controller('api/v1/host-levels')
@UseGuards(JwtAuthGuard)
export class HostRankingController {
  constructor(private readonly service: HostRankingService) {}

  @Get('ranking') ranking(@Query('limit') limit?: string) {
    return this.service.ranking(Number(limit));
  }

  @Get('achievements/me') achievements(@Req() req: AuthedRequest) {
    return this.service.achievements(req.user.userId);
  }
}
