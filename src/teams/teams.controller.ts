import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { TeamsService } from './teams.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  // The caller's own team, or null if they aren't on one.
  @Get('mine')
  mine(@Req() req: AuthedRequest) {
    return this.teams.myTeam(req.user.userId);
  }

  @Get('mine/tribe-board')
  tribeBoard(@Req() req: AuthedRequest) {
    return this.teams.myTeam(req.user.userId).then(team => team ? this.teams.tribeBoard(team.id, req.user.userId) : null);
  }

  @Get('top')
  top(@Query('limit') limit?: string, @Query('countryCode') countryCode?: string) {
    return this.teams.listTopTeams(limit ? Number(limit) : undefined, countryCode);
  }

  @Post()
  create(@Body() body: any, @Req() req: AuthedRequest) {
    return this.teams.createTeam(req.user.userId, {
      name: body?.name,
      description: body?.description,
      themeColor: body?.themeColor ?? null,
      category: body?.category ?? null,
      countryCode: req.user.countryCode,
    });
  }

  @Get(':id')
  snapshot(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.teams.teamSnapshot(id, req.user.userId);
  }

  @Get(':id/roster')
  roster(@Param('id') id: string) {
    return this.teams.listRoster(id);
  }

  @Post(':id/join')
  join(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.teams.joinTeam(req.user.userId, id);
  }

  @Post('leave')
  leave(@Req() req: AuthedRequest) {
    return this.teams.leaveTeam(req.user.userId);
  }

  @Post('moderators/:userId')
  addModerator(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.teams.setModerator(req.user.userId, userId, true);
  }

  @Post('moderators/:userId/remove')
  removeModerator(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.teams.setModerator(req.user.userId, userId, false);
  }
}

@Controller('api/v1/admin/team-levels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminTeamLevelsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  list() {
    return this.teams.listTeamLevels();
  }

  @Put(':level')
  update(@Param('level') level: string, @Body() body: any, @Req() req: AuthedRequest) {
    return this.teams.updateTeamLevel(Number(level), body, req.user.userId, req.user.roles);
  }
}
