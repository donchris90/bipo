import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GiftAdminService } from './gift-admin';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

// The gift catalogue: what gifts exist, their icons and their coin prices. Money
// decisions, so super and finance admins only.
@Controller('api/v1/admin/gifts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN)
export class GiftAdminController {
  constructor(private readonly admin: GiftAdminService) {}

  @Get()
  list() {
    return this.admin.list();
  }

  @Post()
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.admin.create(body, req.user.userId, req.user.roles);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.admin.update(id, body, req.user.userId, req.user.roles);
  }
}
