import { Body, Controller, Get, Param, Put, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoinPackageAdminService } from './coin-package-admin.service';

interface AuthedRequest extends Request { user: { userId: string; roles: RoleName[]; countryCode: string } }

@Controller('api/v1/admin/coin-packages')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN)
export class CoinPackageAdminController {
  constructor(private readonly service: CoinPackageAdminService) {}

  @Get()
  list(@Query('countryCode') countryCode?: string) { return this.service.list(countryCode); }

  @Post()
  create(@Body() body: any, @Req() req: AuthedRequest) { return this.service.upsert(undefined, body, req.user.userId, req.user.roles); }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: AuthedRequest) { return this.service.upsert(id, body, req.user.userId, req.user.roles); }

  @Put(':id/status')
  setActive(@Param('id') id: string, @Body('active') active: boolean, @Req() req: AuthedRequest) { return this.service.setActive(id, !!active, req.user.userId, req.user.roles); }
}
