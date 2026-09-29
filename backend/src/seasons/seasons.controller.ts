import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { SeasonsService } from './seasons.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

@Controller('api/v1/seasons')
@UseGuards(JwtAuthGuard)
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  // The currently-running season, or the next scheduled one, or null.
  @Get('current')
  current() {
    return this.seasons.currentOrNext();
  }

  // Registered before ':id' below — Nest matches routes in declaration order, and 'history'
  // would otherwise be swallowed as a literal :id value.
  @Get('current/hub')
  hub(@Req() req: AuthedRequest) {
    return this.seasons.seasonHub(req.user.userId);
  }

  @Get('history')
  history(@Query('cursor') cursor: string | undefined, @Query('limit') limit: string | undefined, @Req() req: AuthedRequest) {
    return this.seasons.seasonHistory(req.user.userId, cursor, limit ? Number(limit) : undefined);
  }

  @Get(':id')
  snapshot(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.seasons.seasonSnapshot(id, req.user.userId);
  }

  @Get(':id/leaderboard')
  leaderboard(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.seasons.listLeaderboard(id, limit ? Number(limit) : undefined);
  }
}

@Controller('api/v1/admin/seasons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminSeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Get()
  list() {
    return this.seasons.listSeasons();
  }

  @Post()
  create(@Body() body: any, @Req() req: AuthedRequest) {
    return this.seasons.createSeason(req.user.userId, req.user.roles, {
      name: body?.name,
      description: body?.description,
      startsAt: body?.startsAt,
      endsAt: body?.endsAt,
    });
  }

  @Put(':id/reward-tiers')
  setRewardTiers(@Param('id') id: string, @Body() body: any, @Req() req: AuthedRequest) {
    return this.seasons.setRewardTiers(id, req.user.userId, req.user.roles, Array.isArray(body?.tiers) ? body.tiers : []);
  }

  @Post(':id/settle')
  settle(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.seasons.settleSeason(id, req.user.userId, req.user.roles);
  }
}
