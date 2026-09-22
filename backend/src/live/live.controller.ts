import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { LiveMediaService } from './live-media.service';
import { Request } from 'express';
import { LiveService } from './live.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/live')
@UseGuards(JwtAuthGuard)
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly media: LiveMediaService,
  ) {}

  @Get()
  list() {
    return this.live.listLive();
  }

  @Get('mine')
  mine(@Req() req: AuthedRequest) {
    return this.live.findMine(req.user.userId);
  }

  @Get('history')
  history(@Req() req: AuthedRequest) {
    return this.live.findMyWatchHistory(req.user.userId);
  }

  @Post()
  create(
    @Body('title') title: string,
    @Body('category') category: string,
    @Body('themeColor') themeColor: string | undefined,
    @Body('coverUrl') coverUrl: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.live.create(req.user.userId, title, category, req.user.countryCode, themeColor, coverUrl);
  }

  @Post(':id/join')
  join(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.live.joinToken(id, req.user.userId);
  }

  // The video the host is sharing right now (so someone who joins late catches up).
  @Get(':id/media')
  currentMedia(@Param('id') id: string) {
    return this.media.get(id);
  }

  // Host only: load a published video into the live, play, pause, seek, stop.
  @Post(':id/media')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  controlMedia(@Param('id') id: string, @Body() body: { action?: unknown; videoId?: unknown; positionMs?: unknown }, @Req() req: AuthedRequest) {
    return this.media.act(id, req.user.userId, body ?? {});
  }

  @Post(':id/end')
  end(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.live.end(id, req.user.userId);
  }

  // ── Viewer routes (new) ──────────────────────────────────────

  @Get(':id/viewers')
  listViewers(@Param('id') sessionId: string, @Req() req: AuthedRequest) {
    return this.live.listViewers(sessionId, req.user.userId);
  }

  // Public (any authenticated user) — what a viewer's header reads on join.
  @Get(':id/summary')
  summary(@Param('id') sessionId: string) {
    return this.live.summary(sessionId);
  }

  // Backlog for someone joining mid-stream. Live updates then arrive over
  // the socket's 'chat:message' event; merge by id.
  @Get(':id/chat')
  chat(@Param('id') sessionId: string, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.live.chatHistory(sessionId, limit ? Number(limit) : undefined, before);
  }

  // `count` lets the client batch rapid taps into one request.
  @Post(':id/like')
  like(@Param('id') sessionId: string, @Body('count') count: number | undefined, @Req() req: AuthedRequest) {
    return this.live.like(sessionId, req.user.userId, count);
  }

  @Post(':id/kick/:userId')
  kick(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.live.kickViewer(id, req.user.userId, userId);
  }

  @Post(':id/mute/:userId')
  mute(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.live.muteViewer(id, req.user.userId, userId);
  }

  @Post(':id/unmute/:userId')
  unmute(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.live.unmuteViewer(id, req.user.userId, userId);
  }

  @Post(':id/ban/:userId')
  ban(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.live.banViewer(id, req.user.userId, userId);
  }

  @Post(':id/unban/:userId')
  unban(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.live.unbanViewer(id, req.user.userId, userId);
  }

  @Post(':id/leave')
  async leave(@Param('id') sessionId: string, @Req() req: AuthedRequest) {
    await this.live.trackViewerLeave(sessionId, req.user.userId);
    return { ok: true };
  }
}