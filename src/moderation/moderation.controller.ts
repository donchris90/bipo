import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
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

  @Post('moderation/media-signal')
  async mediaSignal(
    @Headers('x-moderation-ingest-key') ingestKey: string | undefined,
    @Body() body: { context: 'LIVE' | 'ROOM'; contextId: string; subjectUserId: string; source: 'AUDIO_TRANSCRIPT' | 'VIDEO_FRAME' | 'VIDEO_STREAM'; category: string; confidence?: number; provider?: string; providerEventId?: string },
  ) {
    const expected = process.env.MODERATION_INGEST_KEY;
    if (!expected || !ingestKey || ingestKey !== expected) {
      throw new UnauthorizedException('Invalid moderation ingest key');
    }
    return this.moderation.ingestMediaSignal(body);
  }

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

  @Get('admin/moderation/media-events')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SAFETY)
  mediaEvents(@Query() query: Record<string, unknown>) {
    return this.moderation.listMediaEvents(query);
  }

  @Get('admin/moderation/rules')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SAFETY)
  rules() {
    return this.moderation.listRules();
  }

  @Post('admin/moderation/rules')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SAFETY)
  createRule(@Body() body: { phrase: string; category: string; severity?: number; action?: string; enforceInPrivate?: boolean }) {
    return this.moderation.createRule(body);
  }

  @Patch('admin/moderation/rules/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SAFETY)
  updateRule(@Param('id') id: string, @Body() body: { phrase?: string; category?: string; severity?: number; action?: string; active?: boolean; enforceInPrivate?: boolean }) {
    return this.moderation.updateRule(id, body);
  }

  @Delete('admin/moderation/rules/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SAFETY)
  deleteRule(@Param('id') id: string) {
    return this.moderation.deleteRule(id);
  }
}
