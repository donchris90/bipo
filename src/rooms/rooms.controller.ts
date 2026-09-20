import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoomsService } from './rooms.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName, RoomPrivacy } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  list() {
    return this.rooms.listOpen();
  }

  @Get('invites')
  myInvites(@Req() req: AuthedRequest) {
    return this.rooms.findMyInvites(req.user.userId);
  }

  @Post('invites/:requestId/decline')
  declineInvite(@Param('requestId') requestId: string, @Req() req: AuthedRequest) {
    return this.rooms.declineInvite(requestId, req.user.userId);
  }

  @Get(':id')
  getDetails(@Param('id') id: string) {
    return this.rooms.getRoomDetails(id);
  }

  @Get(':id/chat')
  chat(@Param('id') id: string, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.rooms.chatHistory(id, limit ? Number(limit) : undefined, before);
  }

  @Patch(':id/theme')
  setTheme(@Param('id') id: string, @Body('themeColor') themeColor: string, @Req() req: AuthedRequest) {
    return this.rooms.setTheme(id, req.user.userId, themeColor);
  }

  @Post(':id/join')
  join(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.joinToken(id, req.user.userId);
  }

  @Post()
  create(
    @Body('title') title: string,
    @Body('privacy') privacy: RoomPrivacy = 'PUBLIC',
    @Body('seatCount') seatCount = 8,
    @Body('category') category: string | undefined,
    @Body('themeColor') themeColor: string | undefined,
    @Body('mode') mode: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.rooms.create(req.user.userId, title, privacy, seatCount, req.user.countryCode, category, themeColor, mode);
  }

  @Post(':id/seats/:seatNumber')
  takeSeat(@Param('id') id: string, @Param('seatNumber') seatNumber: string, @Req() req: AuthedRequest) {
    return this.rooms.requestSeat(id, req.user.userId, Number(seatNumber));
  }

  @Delete(':id/seats/me')
  leaveSeat(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.leaveSeat(id, req.user.userId);
  }

  @Get(':id/seat-requests')
  listSeatRequests(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.listSeatRequests(id, req.user.userId);
  }

  @Post(':id/seat-requests/:requestId/approve/:seatNumber')
  approveSeatRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Param('seatNumber') seatNumber: string,
    @Req() req: AuthedRequest,
  ) {
    return this.rooms.approveSeatRequest(id, req.user.userId, requestId, Number(seatNumber));
  }

  @Post(':id/seat-requests/:requestId/reject')
  rejectSeatRequest(@Param('id') id: string, @Param('requestId') requestId: string, @Req() req: AuthedRequest) {
    return this.rooms.rejectSeatRequest(id, req.user.userId, requestId);
  }

  @Post(':id/invite/:userId')
  inviteToSeat(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.inviteToSeat(id, req.user.userId, userId);
  }

  @Post(':id/invite/accept/:seatNumber')
  acceptInvite(@Param('id') id: string, @Param('seatNumber') seatNumber: string, @Req() req: AuthedRequest) {
    return this.rooms.acceptInvite(id, req.user.userId, Number(seatNumber));
  }

  @Post(':id/remove/:userId')
  removeGuest(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.removeGuest(id, req.user.userId, userId);
  }

  @Post(':id/mute/:userId')
  mute(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.muteGuest(id, req.user.userId, userId);
  }

  @Post(':id/unmute/:userId')
  unmute(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.unmuteGuest(id, req.user.userId, userId);
  }

  @Post(':id/ban/:userId')
  ban(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.banGuest(id, req.user.userId, userId);
  }

  @Post(':id/unban/:userId')
  unban(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.unbanGuest(id, req.user.userId, userId);
  }

  @Post(':id/moderators/:userId')
  addModerator(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.addModerator(id, req.user.userId, userId);
  }

  @Post(':id/lock')
  lock(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.lock(id, req.user.userId, true);
  }

  @Post(':id/unlock')
  unlock(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.lock(id, req.user.userId, false);
  }

  @Post(':id/close')
  close(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.close(id, req.user.userId);
  }
}
