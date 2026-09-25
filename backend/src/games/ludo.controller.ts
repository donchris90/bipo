import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Request } from 'express';
import { LudoService } from './ludo.service';
import { PrismaService } from '../prisma/prisma.service';

interface AuthedRequest extends Request { user: { userId: string; countryCode?: string } }

@Controller('api/v1/ludo')
@UseGuards(JwtAuthGuard)
export class LudoController {
  constructor(private readonly ludo: LudoService, private readonly prisma: PrismaService) {}
  @Get('config')
  async config() {
    const game = await this.ludo.ensureDefinition();
    return game.rulesJson ?? {};
  }
  @Post('quick-match') quick(@Req() req: AuthedRequest, @Body() body: { entryFee: number; playerCount?: 2 | 4; displayName?: string }) { return this.ludo.quickMatch(req.user.userId, body.displayName?.trim() || 'Player', body.entryFee, body.playerCount ?? 4, req.user.countryCode || 'NG'); }
  @Get('quick-match/:ticket') quickStatus(@Req() req: AuthedRequest, @Param('ticket') ticket: string) { return this.ludo.quickMatchStatus(req.user.userId, ticket); }
  @Get('quick-lobby') quickLobby() { return this.ludo.quickMatchLobby(); }
  @Post('quick-match/:ticket/bots') quickBots(@Req() req: AuthedRequest, @Param('ticket') ticket: string) { return this.ludo.startBotMatch(req.user.userId, ticket, true); }
  @Post('quick-match/:ticket/cancel') quickCancel(@Req() req: AuthedRequest, @Param('ticket') ticket: string) { return this.ludo.cancelQuickMatch(req.user.userId, ticket); }
  @Post('rooms') create(@Req() req: AuthedRequest, @Body() body: { entryFee: number; playerCount?: 2 | 4; displayName?: string }) { return this.ludo.createRoom(req.user.userId, body.displayName?.trim() || 'Player', body.entryFee, body.playerCount ?? 4, req.user.countryCode || 'NG'); }
  @Get('rooms/:roomCode/status') roomStatus(@Req() req: AuthedRequest, @Param('roomCode') roomCode: string) { return this.ludo.roomStatus(req.user.userId, roomCode); }
  @Post('rooms/:roomCode/join') join(@Req() req: AuthedRequest, @Param('roomCode') roomCode: string, @Body() body: { displayName?: string }) { return this.ludo.joinRoom(req.user.userId, body.displayName?.trim() || 'Player', roomCode, req.user.countryCode || 'NG'); }
  @Get('candidates/:category')
  candidatesByCategory(@Req() req: AuthedRequest, @Param('category') category: 'friends' | 'agency') { return this.ludo.ludoCandidates(req.user.userId, category); }

  @Get('agency/players')
  async agencyPlayers(@Req() req: AuthedRequest) {
    const membership = await this.prisma.agencyMembership.findFirst({ where: { creatorId: req.user.userId, status: 'ACTIVE' } });
    if (!membership) return [];
    const members = await this.prisma.agencyMembership.findMany({ where: { agencyId: membership.agencyId, status: 'ACTIVE', creatorId: { not: req.user.userId } }, orderBy: { joinedAt: 'asc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: members.map(m => m.creatorId) } }, select: { id: true, displayName: true, avatarUrl: true } });
    return users;
  }

  @Post('matches/:matchId/invite') invite(@Req() req: AuthedRequest, @Param('matchId') matchId: string, @Body() body: { toUserId: string }) { return this.ludo.inviteToRoom(req.user.userId, matchId, body.toUserId); }
  @Get('invites') invites(@Req() req: AuthedRequest) { return this.ludo.listInvites(req.user.userId); }
  @Post('invites/:inviteId/accept') accept(@Req() req: AuthedRequest, @Param('inviteId') inviteId: string, @Body() body: { displayName?: string }) { return this.ludo.acceptInvite(req.user.userId, inviteId, body.displayName?.trim() || 'Player', req.user.countryCode || 'NG'); }
  @Post('invites/:inviteId/decline') decline(@Req() req: AuthedRequest, @Param('inviteId') inviteId: string) { return this.ludo.declineInvite(req.user.userId, inviteId); }
  @Get('matches/:matchId') state(@Param('matchId') matchId: string) { return this.ludo.getState(matchId); }
  @Post('matches/:matchId/roll') roll(@Req() req: AuthedRequest, @Param('matchId') matchId: string) { return this.ludo.roll(req.user.userId, matchId); }
  @Post('matches/:matchId/move') move(@Req() req: AuthedRequest, @Param('matchId') matchId: string, @Body() body: { tokenIndex: number }) { return this.ludo.move(req.user.userId, matchId, body.tokenIndex); }
  @Post('matches/:matchId/reconnect') reconnect(@Req() req: AuthedRequest, @Param('matchId') matchId: string) { return this.ludo.reconnect(req.user.userId, matchId); }
  @Post('matches/:matchId/resume') resume(@Req() req: AuthedRequest, @Param('matchId') matchId: string) { return this.ludo.resume(req.user.userId, matchId); }
  @Post('matches/:matchId/tick') tick(@Req() req: AuthedRequest, @Param('matchId') matchId: string) { return this.ludo.tickAs(req.user.userId, matchId); }
}
