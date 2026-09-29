import { Controller, Get, Param, Post, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FanClubsService } from './fan-clubs.service';

interface AuthedRequest extends Request { user: { userId: string; roles: RoleName[] } }

@Controller('api/v1/creators/:creatorId/fan-club')
@UseGuards(JwtAuthGuard)
export class FanClubsController {
  constructor(private readonly service: FanClubsService) {}

  @Get('me')
  me(@Param('creatorId') creatorId: string, @Req() req: AuthedRequest) { return this.service.me(req.user.userId, creatorId); }

  @Post('join')
  join(@Param('creatorId') creatorId: string, @Req() req: AuthedRequest) { return this.service.join(req.user.userId, creatorId); }

  @Post('leave')
  leave(@Param('creatorId') creatorId: string, @Req() req: AuthedRequest) { return this.service.leave(req.user.userId, creatorId); }
}
