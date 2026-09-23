import { cleanRoomInput } from './room-input';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoomsService } from './rooms.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';

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
  getDetails(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.getRoomDetails(id, req.user.userId);
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

  @Post(':id/join-request')
  joinRequest(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.joinRequest(id, req.user.userId);
  }

  @Post()
  create(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    // Validated and defaulted first: a blank or odd value is fixed or answered with
    // a 400 that names the problem, never passed on to fail inside the database.
    const input = cleanRoomInput(body ?? {});
    return this.rooms.create(req.user.userId, input.title, input.privacy, input.seatCount, req.user.countryCode, input.category, input.themeColor, input.mode);
  }

  @Post(':id/seats/:seatNumber')
  takeSeat(@Param('id') id: string, @Param('seatNumber') seatNumber: string, @Req() req: AuthedRequest) {
    return this.rooms.requestSeat(id, req.user.userId, Number(seatNumber));
  }

  @Post(':id/seats/:seatNumber/move')
  moveOwnSeat(@Param('id') id: string, @Param('seatNumber') seatNumber: string, @Req() req: AuthedRequest) {
    return this.rooms.moveSeat(id, req.user.userId, req.user.userId, Number(seatNumber));
  }

  @Post(':id/seats/:seatNumber/move/:userId')
  moveGuestSeat(@Param('id') id: string, @Param('seatNumber') seatNumber: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.moveSeat(id, req.user.userId, userId, Number(seatNumber));
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

  @Get(':id/invite-candidates')
  inviteCandidates(
    @Param('id') id: string,
    @Query('category') category: string,
    @Query('search') search: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    const value = category === 'fans' || category === 'agency' ? category : 'friends';
    return this.rooms.inviteCandidates(id, req.user.userId, value as 'friends' | 'fans' | 'agency', search);
  }

  // MUST stay above ':id/invite/:userId'. Express matches routes in the order
  // they are declared, so if the parameterised route came first, "accept"
  // would be read as a userId and the guest would get "Requires host or
  // moderator" instead of joining.
  @Post(':id/invite/accept')
  acceptInvite(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.acceptInvite(id, req.user.userId);
  }

  @Post(':id/invite/:userId')
  inviteToSeat(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.inviteToSeat(id, req.user.userId, userId);
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

  @Delete(':id/moderators/:userId')
  removeModerator(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.rooms.removeModerator(id, req.user.userId, userId);
  }

  @Patch(':id/mode')
  setMode(@Param('id') id: string, @Body('mode') mode: string, @Req() req: AuthedRequest) {
    return this.rooms.setMode(id, req.user.userId, mode);
  }

  @Patch(':id/seat-count')
  setSeatCount(@Param('id') id: string, @Body('seatCount') seatCount: number, @Req() req: AuthedRequest) {
    return this.rooms.setSeatCount(id, req.user.userId, Number(seatCount));
  }

  @Post(':id/lock')
  lock(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.lock(id, req.user.userId, true);
  }

  @Post(':id/unlock')
  unlock(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.lock(id, req.user.userId, false);
  }

  @Post(':id/seats/:seatNumber/lock')
  lockSeat(@Param('id') id: string, @Param('seatNumber') seatNumber: string, @Req() req: AuthedRequest) {
    return this.rooms.setSeatLocked(id, req.user.userId, Number(seatNumber), true);
  }

  @Post(':id/seats/:seatNumber/unlock')
  unlockSeat(@Param('id') id: string, @Param('seatNumber') seatNumber: string, @Req() req: AuthedRequest) {
    return this.rooms.setSeatLocked(id, req.user.userId, Number(seatNumber), false);
  }

  @Post(':id/close')
  close(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.rooms.close(id, req.user.userId);
  }
}
