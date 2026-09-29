import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ExperienceService } from './experience.service';
interface AuthedRequest extends Request { user: { userId: string }; }
@Controller('api/v1/experience')
@UseGuards(JwtAuthGuard)
export class ExperienceController {
  constructor(private readonly experience: ExperienceService) {}
  @Get('passport') passport(@Req() req: AuthedRequest) { return this.experience.passport(req.user.userId); }
  @Get('creator-career') creatorCareer(@Req() req: AuthedRequest) { return this.experience.creatorCareer(req.user.userId); }
  @Get('moments') moments(@Req() req: AuthedRequest, @Query('limit') limit?: string) { return this.experience.moments(req.user.userId, limit ? Number(limit) : 30); }
  @Get('moments/global') global(@Query('limit') limit?: string) { return this.experience.globalMoments(limit ? Number(limit) : 30); }
  @Get('moments/discover') discoverMoments(@Req() req: AuthedRequest, @Query('limit') limit?: string) { return this.experience.discoverMoments(req.user.userId, limit ? Number(limit) : 30); }
}
