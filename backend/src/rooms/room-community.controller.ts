import { Body, Controller, ForbiddenException, Get, Param, Patch, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { RoomCommunityService } from './room-community.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

// Nested under the host's id (not a PartyRoom session id) — the Community tab is about the
// PERSISTENT room, which outlives any one session, same reasoning as
// SupporterLevelsController being nested under :creatorId rather than a gift transaction id.
@Controller('api/v1/rooms/host/:hostId/community')
@UseGuards(JwtAuthGuard)
export class RoomCommunityController {
  constructor(private readonly service: RoomCommunityService) {}

  @Get()
  snapshot(@Param('hostId') hostId: string, @Req() req: AuthedRequest) {
    return this.service.communitySnapshot(hostId, req.user.userId);
  }

  @Get('regulars')
  regulars(@Param('hostId') hostId: string, @Query('limit') limit?: string) {
    return this.service.listRegulars(hostId, limit ? Number(limit) : undefined);
  }

  // The caller's own room-community achievements (catalog + earned state) — see
  // RoomCommunityService.listAchievementsForHost. `listAchievements(roomId, userId)` on the
  // service existed with no route calling it at all before this.
  @Get('achievements')
  achievements(@Param('hostId') hostId: string, @Req() req: AuthedRequest) {
    return this.service.listAchievementsForHost(hostId, req.user.userId);
  }

  @Patch()
  updateIdentity(@Param('hostId') hostId: string, @Body() body: any, @Req() req: AuthedRequest) {
    // The host editing their own room identity — RoomsService's existing host/moderator checks
    // don't apply here since this isn't scoped to a live session; simple self-only check instead.
    if (req.user.userId !== hostId) {
      throw new ForbiddenException('Only the host can edit their room identity');
    }
    return this.service.setIdentity(hostId, body ?? {});
  }
}

@Controller('api/v1/admin/room-levels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminRoomLevelsController {
  constructor(private readonly service: RoomCommunityService) {}

  @Get()
  list() {
    return this.service.listRoomLevels();
  }

  @Put(':level')
  update(@Param('level') level: string, @Body() body: any, @Req() req: AuthedRequest) {
    return this.service.updateRoomLevel(Number(level), body, req.user.userId, req.user.roles);
  }
}

// The visitor's own standing curve inside a room — distinct from AdminRoomLevelsController above,
// which edits the room's own level. No admin UI or endpoints existed for this curve at all before.
@Controller('api/v1/admin/room-member-levels')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminRoomMemberLevelsController {
  constructor(private readonly service: RoomCommunityService) {}

  @Get()
  list() {
    return this.service.listRoomMemberLevels();
  }

  @Put(':level')
  update(@Param('level') level: string, @Body() body: any, @Req() req: AuthedRequest) {
    return this.service.updateRoomMemberLevel(Number(level), body, req.user.userId, req.user.roles);
  }
}
