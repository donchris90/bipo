import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { v4 as uuid } from 'uuid';
import { CreatorApplicationService } from './creator-application.service';
import { CreatorAnalyticsService, parsePeriod } from './creator-analytics.service';
import { WithdrawalService, parseWithdrawableWallet } from './withdrawal.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/creators')
@UseGuards(JwtAuthGuard)
export class CreatorsController {
  constructor(
    private readonly applications: CreatorApplicationService,
    private readonly analytics: CreatorAnalyticsService,
  ) {}

  @Post('apply')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  apply(@Req() req: AuthedRequest) {
    return this.applications.apply(req.user.userId);
  }

  // Live time, followers gained, gift totals, creator earnings and PK record
  // over a rolling window (?period=today|week|month|all, default week),
  // derived from existing rows. Audience country/language (spec §32) still
  // needs data that isn't collected yet and is not part of this.
  @Get('dashboard')
  dashboard(@Req() req: AuthedRequest, @Query('period') period?: string) {
    return this.analytics.dashboard(req.user.userId, parsePeriod(period));
  }

  // Top gift recipients in the window (?period=today|week|month|all, default
  // today) with follower count and PK wins.
  @Get('leaderboard')
  leaderboard(@Req() req: AuthedRequest, @Query('period') period?: string, @Query('limit') limit?: string) {
    return this.analytics.leaderboard(req.user.userId, parsePeriod(period, 'today'), limit ? Number(limit) : undefined);
  }
}

@Controller('api/v1/creators/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CreatorApplicationsAdminController {
  constructor(private readonly applications: CreatorApplicationService) {}

  @Post(':id/approve')
  @Roles(RoleName.SUPER_ADMIN, RoleName.TRUST_SAFETY_ADMIN)
  approve(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.applications.review(id, true, req.user.userId, req.user.roles);
  }

  @Post(':id/reject')
  @Roles(RoleName.SUPER_ADMIN, RoleName.TRUST_SAFETY_ADMIN)
  reject(@Param('id') id: string, @Body('reason') reason: string, @Req() req: AuthedRequest) {
    return this.applications.review(id, false, req.user.userId, req.user.roles, reason);
  }
}

@Controller('api/v1/withdrawals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @Post()
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  request(
    @Body('amountCoins') amountCoins: number,
    @Body('currencyCode') currencyCode: string,
    @Body('idempotencyKey') idempotencyKey: string,
    @Body('walletType') walletType: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.withdrawals.request(
      req.user.userId,
      amountCoins,
      currencyCode,
      idempotencyKey ?? uuid(),
      parseWithdrawableWallet(walletType),
      req.user.countryCode,
    );
  }

  // The caller's own payout history (newest first). ?walletType=
  // CREATOR_EARNINGS|AGENCY_EARNINGS narrows it, ?before=<requestedAt> pages.
  // Declared as a fixed literal path; the only ':id' routes on this
  // controller are POSTs, so there is no wildcard for it to collide with.
  @Get('mine')
  mine(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('walletType') walletType?: string,
  ) {
    return this.withdrawals.listMine(req.user.userId, {
      limit: limit ? Number(limit) : undefined,
      before,
      walletType: walletType ? parseWithdrawableWallet(walletType) : undefined,
    });
  }

  @Post(':id/approve')
  @Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN)
  approve(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.withdrawals.approve(id, req.user.userId, req.user.roles);
  }

  @Post(':id/reject')
  @Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN)
  reject(@Param('id') id: string, @Body('reason') reason: string, @Req() req: AuthedRequest) {
    return this.withdrawals.reject(id, req.user.userId, req.user.roles, reason);
  }
}
