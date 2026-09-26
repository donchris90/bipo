import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { RrydaLevelsService } from './rryda-levels.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

@Controller('api/v1/users/me/rryda-level')
@UseGuards(JwtAuthGuard)
export class RrydaLevelsController {
  constructor(private readonly rrydaLevels: RrydaLevelsService) {}

  @Get()
  progress(@Req() req: AuthedRequest) {
    return this.rrydaLevels.progress(req.user.userId);
  }
}

@Controller('api/v1/admin/rryda-levels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminRrydaLevelsController {
  constructor(private readonly rrydaLevels: RrydaLevelsService) {}

  @Get()
  list() {
    return this.rrydaLevels.list();
  }

  @Put(':level')
  update(@Param('level') level: string, @Body() body: any, @Req() req: AuthedRequest) {
    return this.rrydaLevels.updateLevel(Number(level), body, req.user.userId, req.user.roles);
  }
}
