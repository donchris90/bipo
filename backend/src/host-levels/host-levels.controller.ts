import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { HostLevelsService } from './host-levels.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request { user: { userId: string; roles: RoleName[] }; }

@Controller('api/v1/host-levels')
@UseGuards(JwtAuthGuard)
export class HostLevelsController {
  constructor(private readonly service: HostLevelsService) {}
  @Get('me') me(@Req() req: AuthedRequest) { return this.service.progress(req.user.userId); }
  @Get('tasks/me') tasksMe(@Req() req: AuthedRequest) { return this.service.dailyTasks(req.user.userId); }
  @Get() list() { return this.service.list(); }
}

@Controller('api/v1/admin/host-levels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminHostLevelsController {
  constructor(private readonly service: HostLevelsService) {}
  @Get() list() { return this.service.list(); }
  @Get('rules') rules() { return this.service.rules(); }
  @Get('tasks') tasks() { return this.service.listTasks(); }
  @Put('tasks/:key') updateTask(@Param('key') key: string, @Body() body: any, @Req() req: AuthedRequest) { return this.service.updateTask(key, body, req.user.userId, req.user.roles[0]); }
  @Put('rules/:key') updateRule(@Param('key') key: string, @Body() body: any, @Req() req: AuthedRequest) { return this.service.updateRule(key, body, req.user.userId, req.user.roles[0]); }
  @Put(':level') update(@Param('level') level: string, @Body() body: any, @Req() req: AuthedRequest) { return this.service.updateLevel(Number(level), body, req.user.userId, req.user.roles); }
}
