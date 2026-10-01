import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Request } from 'express';
import { AyoService } from './ayo.service';

interface AuthedRequest extends Request { user: { userId: string; countryCode?: string } }

@Controller('api/v1/ayo')
@UseGuards(JwtAuthGuard)
export class AyoController {
  constructor(private readonly ayo: AyoService) {}

  @Get('config')
  config() { return this.ayo.config(); }

  @Post('quick-match')
  quick(@Req() req: AuthedRequest, @Body() body: { entryFee: number; displayName?: string }) {
    return this.ayo.quickMatch(req.user.userId, body.displayName?.trim() || 'Player', Number(body.entryFee), req.user.countryCode || 'NG');
  }

  @Get('quick-match/:ticket')
  quickStatus(@Req() req: AuthedRequest, @Param('ticket') ticket: string) {
    return this.ayo.quickStatus(req.user.userId, ticket);
  }

  @Post('quick-match/:ticket/cancel')
  quickCancel(@Req() req: AuthedRequest, @Param('ticket') ticket: string) {
    return this.ayo.cancelQuick(req.user.userId, ticket);
  }

  @Get('quick-lobby')
  quickLobby() { return this.ayo.quickLobby(); }

  @Post('rooms')
  createRoom(@Req() req: AuthedRequest, @Body() body: { entryFee: number; displayName?: string }) {
    return this.ayo.createRoom(req.user.userId, body.displayName?.trim() || 'Player', Number(body.entryFee), req.user.countryCode || 'NG');
  }

  @Post('party/:roomId')
  createParty(@Req() req: AuthedRequest, @Param('roomId') roomId: string, @Body() body: { entryFee: number }) {
    return this.ayo.createPartyRoom(req.user.userId, roomId, Number(body.entryFee), req.user.countryCode || 'NG');
  }

  @Get('party/:roomId/status')
  partyStatus(@Req() req: AuthedRequest, @Param('roomId') roomId: string) {
    return this.ayo.partyRoomStatus(req.user.userId, roomId);
  }

  @Post('party/:roomId/join')
  joinParty(@Req() req: AuthedRequest, @Param('roomId') roomId: string, @Body() body: { displayName?: string }) {
    return this.ayo.joinPartyRoom(req.user.userId, roomId, body.displayName?.trim() || 'Player', req.user.countryCode || 'NG');
  }

  @Get('rooms/:roomCode/status')
  roomStatus(@Req() req: AuthedRequest, @Param('roomCode') code: string) {
    return this.ayo.roomStatus(req.user.userId, code);
  }

  @Post('rooms/:roomCode/join')
  joinRoom(@Req() req: AuthedRequest, @Param('roomCode') code: string, @Body() body: { displayName?: string }) {
    return this.ayo.joinRoom(req.user.userId, body.displayName?.trim() || 'Player', code, req.user.countryCode || 'NG');
  }

  @Get('matches/:matchId')
  state(@Param('matchId') matchId: string) { return this.ayo.getState(matchId); }

  @Post('matches/:matchId/move')
  move(@Req() req: AuthedRequest, @Param('matchId') matchId: string, @Body() body: { pit: number }) {
    return this.ayo.move(req.user.userId, matchId, Number(body.pit));
  }

  @Post('matches/:matchId/decide')
  decide(@Req() req: AuthedRequest, @Param('matchId') matchId: string, @Body() body: { quit: boolean }) {
    return this.ayo.decide(req.user.userId, matchId, body?.quit === true);
  }

  @Get('matches/:matchId/spectator-bets')
  spectatorBets(@Req() req: AuthedRequest, @Param('matchId') matchId: string) {
    return this.ayo.spectatorBetStatus(req.user.userId, matchId);
  }

  @Post('matches/:matchId/spectator-bets')
  spectatorBet(@Req() req: AuthedRequest, @Param('matchId') matchId: string, @Body() body: { playerUserId: string; amount: number }) {
    return this.ayo.placeSpectatorBet(req.user.userId, matchId, body.playerUserId, Number(body.amount));
  }
}
