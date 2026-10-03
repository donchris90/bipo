import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RevenueSplitAdminService } from './revenue-split-admin.service';

interface AuthedRequest extends Request { user: { userId: string; roles: RoleName[] } }

@Controller('api/v1/admin/revenue-splits')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN)
export class RevenueSplitAdminController {
  constructor(private readonly service: RevenueSplitAdminService) {}
  @Get() list() { return this.service.list(); }
  @Put() upsert(@Body() body: unknown, @Req() req: AuthedRequest) { return this.service.upsert(body, req.user.userId, req.user.roles); }
}
