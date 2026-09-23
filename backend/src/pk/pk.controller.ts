import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { PkService } from './pk.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

// PKBattle.scoreChallenger/scoreOpponent are BigInt (spec allows arbitrarily
// large PK scores without overflow) — Express's JSON serializer throws on
// BigInt with no coercion, so every response needs this same treatment
// WalletController and ReconciliationController already use. Missed here
// on the first pass; this is what "not stubbed for content that isn't
// buildable yet" doesn't cover — plain oversight, caught by actually
// running it.
function toResponse(battle: any) {
  return {
    ...battle,
    scoreChallenger: battle.scoreChallenger?.toString(),
    scoreOpponent: battle.scoreOpponent?.toString(),
  };
}

@Controller('api/v1/pk')
@UseGuards(JwtAuthGuard)
export class PkController {
  constructor(private readonly pk: PkService) {}

  @Post('challenge/:opponentId')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async challenge(@Param('opponentId') opponentId: string, @Req() req: AuthedRequest) {
    return toResponse(await this.pk.challenge(req.user.userId, opponentId));
  }

  // Who you can challenge, online right now: ?category=friends | agency | random
  @Get('candidates')
  candidates(@Query('category') category: string | undefined, @Req() req: AuthedRequest) {
    const cat = category === 'agency' || category === 'random' ? category : 'friends';
    return this.pk.candidates(req.user.userId, cat);
  }

  // "Random match": challenge one online creator picked for you.
  @Post('random')
  async random(@Req() req: AuthedRequest) {
    const { battle, opponent } = await this.pk.randomChallenge(req.user.userId);
    return { battle: toResponse(battle), opponent };
  }

  // The challenger withdraws an unanswered invitation.
  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Req() req: AuthedRequest) {
    return toResponse(await this.pk.cancel(id, req.user.userId));
  }

  // A host ends the PK early: called off during the countdown, a loss once
  // it has started.
  @Post(':id/forfeit')
  async forfeit(@Param('id') id: string, @Req() req: AuthedRequest) {
    return toResponse(await this.pk.forfeit(id, req.user.userId));
  }

  @Post(':id/decline')
  async decline(@Param('id') id: string, @Req() req: AuthedRequest) {
    return toResponse(await this.pk.decline(id, req.user.userId));
  }

  @Post(':id/accept')
  async accept(@Param('id') id: string, @Req() req: AuthedRequest) {
    return toResponse(await this.pk.accept(id, req.user.userId));
  }

  // The caller's settled battles, newest first, plus their overall record.
  // `before` (ISO timestamp — the settledAt of the last row already loaded)
  // pages further back. Must come before @Get(':id') like 'incoming'.
  @Get('history')
  history(@Req() req: AuthedRequest, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.pk.history(req.user.userId, limit ? Number(limit) : undefined, before);
  }

  // My invitation that is still waiting for an answer (or null). Before ':id'.
  @Get('outgoing')
  async outgoing(@Req() req: AuthedRequest) {
    const result = await this.pk.outgoing(req.user.userId);
    return result ? { ...result, battle: toResponse(result.battle) } : null;
  }

  // Must come before the @Get(':id') wildcard below — NestJS matches
  // routes in declaration order, and ':id' would otherwise swallow this
  // path as if 'incoming' were a battle id.
  @Get('incoming')
  async incoming(@Req() req: AuthedRequest) {
    const battles = await this.pk.incomingChallenges(req.user.userId);
    return battles.map(toResponse);
  }

  // Must come before the @Get(':id') wildcard below — same reasoning as
  // 'incoming' above.
  @Get('active-for-host/:hostId')
  async activeForHost(@Param('hostId') hostId: string) {
    const result = await this.pk.findActiveForHost(hostId);
    if (!result) return null;
    return { ...result, battle: toResponse(result.battle) };
  }

  @Post(':id/activate')
  async activate(@Param('id') id: string) {
    return toResponse(await this.pk.activateIfDue(id));
  }

  @Post(':id/settle')
  async settle(@Param('id') id: string) {
    return toResponse(await this.pk.settleIfDue(id));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return toResponse(await this.pk.get(id));
  }
}
