import { Body, Controller, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { SupporterLevelsService } from './supporter-levels.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

// Viewer-facing: a supporter's own progress toward one creator, and that creator's lifetime
// leaderboard. Nested under the creator's id (not "me") because, unlike RrydaLevel/HostLevel,
// there's no single progress value for a user — it's always relative to a specific creator.
@Controller('api/v1/creators/:creatorId/supporter-level')
@UseGuards(JwtAuthGuard)
export class SupporterLevelsController {
  constructor(private readonly service: SupporterLevelsService) {}

  @Get('me')
  me(@Param('creatorId') creatorId: string, @Req() req: AuthedRequest) {
    return this.service.progress(req.user.userId, creatorId);
  }

  @Get('top')
  top(@Param('creatorId') creatorId: string, @Query('limit') limit?: string) {
    return this.service.topSupporters(creatorId, limit ? Number(limit) : undefined);
  }
}

@Controller('api/v1/admin/supporter-levels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminSupporterLevelsController {
  constructor(private readonly service: SupporterLevelsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Put(':level')
  update(@Param('level') level: string, @Body() body: any, @Req() req: AuthedRequest) {
    return this.service.updateLevel(Number(level), body, req.user.userId, req.user.roles);
  }
}
