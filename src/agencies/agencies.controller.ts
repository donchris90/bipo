import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AgenciesService } from './agencies.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName } from '@prisma/client';
import { parsePeriod } from '../creators/creator-analytics.service';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/agencies')
@UseGuards(JwtAuthGuard)
export class AgenciesController {
  constructor(private readonly agencies: AgenciesService) {}

  @Post()
  register(@Body('name') name: string, @Req() req: AuthedRequest) {
    return this.agencies.register(req.user.userId, name);
  }

  // Fixed-literal GET/POST routes below are all multi-segment or distinct literals, so they cannot
  // be swallowed by ':id/...' regardless of declaration order.
  @Get('eligibility')
  eligibility(@Req() req: AuthedRequest) {
    return this.agencies.eligibility(req.user.userId);
  }

  // Admin: the level needed to start an agency, and making anyone an agency regardless of it.
  @Get('admin/config')
  @UseGuards(RolesGuard)
  @Roles(RoleName.SUPER_ADMIN)
  getConfig() {
    return this.agencies.getConfig();
  }

  @Put('admin/config')
  @UseGuards(RolesGuard)
  @Roles(RoleName.SUPER_ADMIN)
  updateConfig(@Body('minRrydaLevel') minRrydaLevel: unknown, @Req() req: AuthedRequest) {
    return this.agencies.updateConfig(minRrydaLevel, req.user.userId, req.user.roles);
  }

  @Post('admin/create')
  @UseGuards(RolesGuard)
  @Roles(RoleName.SUPER_ADMIN)
  adminCreate(@Body('ownerId') ownerId: unknown, @Body('name') name: unknown, @Req() req: AuthedRequest) {
    return this.agencies.adminCreate(req.user.userId, req.user.roles, ownerId, name);
  }

  @Get('directory')
  directory(@Query('q') q?: string) {
    return this.agencies.directory(q);
  }

  @Get('me/requests')
  myRequests(@Req() req: AuthedRequest) {
    return this.agencies.myRequests(req.user.userId);
  }

  @Post('me/leave')
  leave(@Req() req: AuthedRequest) {
    return this.agencies.leave(req.user.userId);
  }

  @Post('requests/:requestId/accept')
  acceptRequest(@Param('requestId') requestId: string, @Body('commissionBps') commissionBps: number | undefined, @Req() req: AuthedRequest) {
    return this.agencies.respond(requestId, req.user.userId, 'accept', commissionBps);
  }

  @Post('requests/:requestId/decline')
  declineRequest(@Param('requestId') requestId: string, @Req() req: AuthedRequest) {
    return this.agencies.respond(requestId, req.user.userId, 'decline');
  }

  @Post('requests/:requestId/cancel')
  cancelRequest(@Param('requestId') requestId: string, @Req() req: AuthedRequest) {
    return this.agencies.respond(requestId, req.user.userId, 'cancel');
  }

  @Post(':id/apply')
  apply(@Param('id') id: string, @Body('message') message: string | undefined, @Req() req: AuthedRequest) {
    return this.agencies.apply(id, req.user.userId, message);
  }

  @Post(':id/invite')
  invite(
    @Param('id') id: string,
    @Body('creatorId') creatorId: string,
    @Body('commissionBps') commissionBps: number,
    @Req() req: AuthedRequest,
  ) {
    return this.agencies.invite(id, req.user.userId, creatorId, commissionBps);
  }

  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles(RoleName.SUPER_ADMIN)
  approve(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.agencies.approve(id, req.user.userId, req.user.roles);
  }

  @Post(':id/creators/:creatorId')
  addCreator(
    @Param('id') id: string,
    @Param('creatorId') creatorId: string,
    @Body('commissionBps') commissionBps: number,
    @Req() req: AuthedRequest,
  ) {
    return this.agencies.addCreator(id, creatorId, commissionBps, req.user.userId);
  }

  @Delete(':id/creators/:creatorId')
  removeCreator(@Param('id') id: string, @Param('creatorId') creatorId: string, @Req() req: AuthedRequest) {
    return this.agencies.removeCreator(id, creatorId, req.user.userId);
  }

  @Get(':id/creators')
  listCreators(@Param('id') id: string) {
    return this.agencies.listCreators(id);
  }

  // Registered as a distinct path segment ('me'), not ':id' — this is a
  // fixed literal route, so there's no NestJS route-ordering conflict with
  // ':id/creators' above regardless of declaration order. Fixes the
  // mobile app's AgencyScreen, which has been calling this exact path
  // since it was written but got a 404 because this handler never existed.
  @Get('me')
  myMembership(@Req() req: AuthedRequest) {
    return this.agencies.myMembership(req.user.userId);
  }

  // The caller's own agency as its owner: commission earned, withdrawable
  // agency balance, and member performance over ?period=today|week|month|all
  // (default week). Null if the caller owns no agency.
  @Get('me/dashboard')
  ownerDashboard(@Req() req: AuthedRequest, @Query('period') period?: string) {
    return this.agencies.ownerDashboard(req.user.userId, parsePeriod(period));
  }
}
