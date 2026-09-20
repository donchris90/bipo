import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { VideosService } from './videos.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

// Publishing is a creator programme; watching and liking is open to everyone.
function assertCreator(req: AuthedRequest) {
  if (!req.user.roles.includes(RoleName.CREATOR)) {
    throw new ForbiddenException('Only approved creators can publish videos');
  }
}

@Controller('api/v1/videos')
@UseGuards(JwtAuthGuard)
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  // ── Creator ──

  // Step 1 of publishing: get an upload URL for a file of this type/size.
  @Post('uploads')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  requestUpload(
    @Body('contentType') contentType: string,
    @Body('sizeBytes') sizeBytes: number,
    @Req() req: AuthedRequest,
  ) {
    assertCreator(req);
    return this.videos.requestUpload(req.user.userId, contentType, sizeBytes);
  }

  // Step 2: the file is uploaded — publish it.
  @Post()
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  publish(
    @Body()
    body: {
      storageKey: string;
      title: string;
      caption?: string;
      tag?: string;
      durationSeconds?: number;
      allowGifts?: boolean;
    },
    @Req() req: AuthedRequest,
  ) {
    assertCreator(req);
    return this.videos.publish(req.user.userId, req.user.countryCode, body ?? ({} as any));
  }

  // Fixed literal paths ('mine') are declared before the ':id' wildcards.
  @Get('mine')
  mine(@Req() req: AuthedRequest) {
    assertCreator(req);
    return this.videos.mine(req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { title?: string; caption?: string; tag?: string; allowGifts?: boolean },
    @Req() req: AuthedRequest,
  ) {
    assertCreator(req);
    return this.videos.update(req.user.userId, id, body ?? {});
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    assertCreator(req);
    return this.videos.remove(req.user.userId, id);
  }

  // ── Everyone ──

  @Get()
  feed(@Req() req: AuthedRequest, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.videos.feed(req.user.userId, limit ? Number(limit) : undefined, before);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.videos.get(req.user.userId, id);
  }

  @Post(':id/view')
  view(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.videos.recordView(req.user.userId, id);
  }

  @Post(':id/like')
  like(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.videos.like(req.user.userId, id);
  }

  @Delete(':id/like')
  unlike(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.videos.unlike(req.user.userId, id);
  }
}
