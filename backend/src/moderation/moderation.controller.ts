import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ModerationService } from './moderation.service';

interface AuthedRequest extends Request { user: { userId: string; roles: RoleName[] } }
const SAFETY = [RoleName.SUPER_ADMIN, RoleName.TRUST_SAFETY_ADMIN];

@Controller('api/v1')
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Post('moderation/reports')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  create(@Req() req: AuthedRequest, @Body() body: { targetUserId: string; category: string; description?: string; context?: string; contextId?: string }) {
    return this.moderation.createReport(req.user.userId, body);
  }

  @Get('admin/reports')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SAFETY)
  list(@Query() query: Record<string, unknown>) { return this.moderation.listReports(query); }

  @Patch('admin/reports/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SAFETY)
  resolve(@Param('id') id: string, @Req() req: AuthedRequest, @Body() body: { status: string; resolution?: string }) {
    return this.moderation.resolveReport(id, req.user.userId, body);
  }
}
