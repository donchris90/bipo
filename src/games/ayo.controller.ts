import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
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
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  quick(@Req() req: AuthedRequest, @Body() body: { entryFee: number; displayName?: string }) {
    return this.ayo.quickMatch(req.user.userId, body.displayName?.trim() || 'Player', Number(body.entryFee), req.user.countryCode || 'NG');
  }

  @Get('quick-match/:ticket')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  quickStatus(@Req() req: AuthedRequest, @Param('ticket') ticket: string) {
    return this.ayo.quickStatus(req.user.userId, ticket);
  }

  @Post('quick-match/:ticket/cancel')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  quickCancel(@Req() req: AuthedRequest, @Param('ticket') ticket: string) {
    return this.ayo.cancelQuick(req.user.userId, ticket);
  }

  @Get('quick-lobby')
  quickLobby() { return this.ayo.quickLobby(); }

  @Post('rooms')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createRoom(@Req() req: AuthedRequest, @Body() body: { entryFee: number; displayName?: string }) {
    return this.ayo.createRoom(req.user.userId, body.displayName?.trim() || 'Player', Number(body.entryFee), req.user.countryCode || 'NG');
  }

  @Post('party/:roomId')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createParty(@Req() req: AuthedRequest, @Param('roomId') roomId: string, @Body() body: { entryFee: number }) {
    return this.ayo.createPartyRoom(req.user.userId, roomId, Number(body.entryFee), req.user.countryCode || 'NG');
  }

  @Get('party/:roomId/status')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  partyStatus(@Req() req: AuthedRequest, @Param('roomId') roomId: string) {
    return this.ayo.partyRoomStatus(req.user.userId, roomId);
  }

  @Post('party/:roomId/join')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  joinParty(@Req() req: AuthedRequest, @Param('roomId') roomId: string, @Body() body: { displayName?: string }) {
    return this.ayo.joinPartyRoom(req.user.userId, roomId, body.displayName?.trim() || 'Player', req.user.countryCode || 'NG');
  }

  @Get('rooms/:roomCode/status')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  roomStatus(@Req() req: AuthedRequest, @Param('roomCode') code: string) {
    return this.ayo.roomStatus(req.user.userId, code);
  }

  @Post('rooms/:roomCode/join')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  joinRoom(@Req() req: AuthedRequest, @Param('roomCode') code: string, @Body() body: { displayName?: string }) {
    return this.ayo.joinRoom(req.user.userId, body.displayName?.trim() || 'Player', code, req.user.countryCode || 'NG');
  }

  @Get('matches/:matchId')
  state(@Param('matchId') matchId: string) { return this.ayo.getState(matchId); }

  @Post('matches/:matchId/move')
  move(@Req() req: AuthedRequest, @Param('matchId') matchId: string, @Body() body: { pit: number }) {
    return this.ayo.move(req.user.userId, matchId, Number(body.pit));
  }

  @Get('matches/:matchId/spectator-bets')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  spectatorBets(@Req() req: AuthedRequest, @Param('matchId') matchId: string) {
    return this.ayo.spectatorBetStatus(req.user.userId, matchId);
  }

  @Post('matches/:matchId/spectator-bets')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  spectatorBet(@Req() req: AuthedRequest, @Param('matchId') matchId: string, @Body() body: { playerUserId: string; amount: number }) {
    return this.ayo.placeSpectatorBet(req.user.userId, matchId, body.playerUserId, Number(body.amount));
  }
}
