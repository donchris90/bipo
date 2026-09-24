import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { AdminService } from './admin.service';
import { PayoutConfigService } from '../payouts/payout-config.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../videos/providers/storage-provider.interface';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

const ANY_ADMIN = [RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN, RoleName.TRUST_SAFETY_ADMIN, RoleName.GAME_OPERATOR];
const TRUST_SAFETY = [RoleName.SUPER_ADMIN, RoleName.TRUST_SAFETY_ADMIN];
const FINANCE = [RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN];
const GAMES = [RoleName.SUPER_ADMIN, RoleName.GAME_OPERATOR];

// Read-only data for the admin dashboard. Each route is limited to the roles
// that are allowed to act on that data; the dashboard's write actions use the
// existing guarded endpoints (users/:id/suspend, withdrawals/:id/approve, ...).
@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly payoutConfig: PayoutConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  @Get('overview')
  @Roles(...ANY_ADMIN)
  overview(@Req() req: AuthedRequest) {
    return this.admin.overview(req.user.roles);
  }

  @Put('users/:id/coins')
  @Roles(...FINANCE)
  grantCoins(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.admin.grantCoins(id, body);
  }

  @Get('users')
  @Roles(...TRUST_SAFETY, RoleName.FINANCE_ADMIN)
  users(@Query() q: Record<string, unknown>) {
    return this.admin.users(q);
  }

  @Get('creator-applications')
  @Roles(...TRUST_SAFETY)
  creatorApplications(@Query() q: Record<string, unknown>) {
    return this.admin.creatorApplications(q);
  }

  @Get('withdrawals')
  @Roles(...FINANCE)
  withdrawals(@Query() q: Record<string, unknown>) {
    return this.admin.withdrawals(q);
  }

  @Get('purchases')
  @Roles(...FINANCE)
  purchases(@Query() q: Record<string, unknown>) {
    return this.admin.purchases(q);
  }

  @Get('agencies')
  @Roles(...TRUST_SAFETY)
  agencies(@Query() q: Record<string, unknown>) {
    return this.admin.agencies(q);
  }

  @Get('live-sessions')
  @Roles(...ANY_ADMIN)
  liveSessions(@Query() q: Record<string, unknown>) {
    return this.admin.liveSessions(q);
  }

  @Get('audit-log')
  @Roles(...TRUST_SAFETY)
  auditLog(@Query() q: Record<string, unknown>) {
    return this.admin.auditLog(q);
  }

  @Get('moderation-actions')
  @Roles(...TRUST_SAFETY)
  moderationActions(@Query() q: Record<string, unknown>) {
    return this.admin.moderationActions(q);
  }

  @Get('games')
  @Roles(...GAMES)
  games() {
    return this.admin.games();
  }

  // What a coin is worth in cash, the smallest/largest withdrawal and the fee,
  // per country. Set here, never in code.
  @Get('payout-config')
  @Roles(...FINANCE)
  payoutConfigs() {
    return this.payoutConfig.listForAdmin();
  }

  @Put('payout-config/:countryCode')
  @Roles(...FINANCE)
  setPayoutConfig(@Param('countryCode') countryCode: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.payoutConfig.upsert(countryCode, body, req.user.userId, req.user.roles);
  }

  // "Test video storage": can the server reach the bucket with its credentials?
  @Get('storage/check')
  @Roles(RoleName.SUPER_ADMIN)
  storageCheck() {
    return this.storage.check ? this.storage.check() : { ok: false, errorName: 'Unsupported', errorMessage: 'This storage provider has no self-test' };
  }
}
