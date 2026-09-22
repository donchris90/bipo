import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AnnouncementsService } from './announcements.service';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

// What the scrolling strip on the Live and Party screens shows.
@Controller('api/v1/announcements')
@UseGuards(JwtAuthGuard)
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  banner() {
    return this.announcements.banner();
  }
}

@Controller('api/v1/admin/announcements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN, RoleName.TRUST_SAFETY_ADMIN)
export class AnnouncementsAdminController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list() {
    return this.announcements.list();
  }

  @Post()
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.announcements.create(body, req.user.userId, req.user.roles);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.announcements.update(id, body, req.user.userId, req.user.roles);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.announcements.remove(id, req.user.userId, req.user.roles);
  }
}
