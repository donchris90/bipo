import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query('unreadOnly') unreadOnly?: string) {
    return this.notifications.list(req.user.userId, unreadOnly === 'true');
  }

  // Cheap counts for the tab-bar badge — see NotificationsService.unreadCounts().
  // Declared before the ':id' routes so 'unread-count' is never read as an id.
  @Get('unread-count')
  unreadCount(@Req() req: AuthedRequest) {
    return this.notifications.unreadCounts(req.user.userId);
  }

  // Register / remove this device for phone push. Registration is keyed by
  // token, so calling it again on every app start is fine.
  @Post('push-token')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  registerPushToken(@Body('token') token: string, @Body('platform') platform: string | undefined, @Req() req: AuthedRequest) {
    return this.push.register(req.user.userId, token, platform);
  }

  @Delete('push-token')
  removePushToken(@Body('token') token: string, @Req() req: AuthedRequest) {
    return this.push.unregister(req.user.userId, token);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.notifications.markRead(req.user.userId, id);
  }

  @Patch('read-all')
  markAllRead(@Req() req: AuthedRequest) {
    return this.notifications.markAllRead(req.user.userId);
  }
}
