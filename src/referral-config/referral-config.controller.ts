import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ReferralConfigService } from './referral-config.service';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

@Controller('api/v1/admin/referral-config')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN)
export class ReferralConfigController {
  constructor(private readonly config: ReferralConfigService) {}

  @Get()
  get() {
    return this.config.getConfig();
  }

  @Put()
  update(@Body() body: { rewardCoins?: number }, @Req() req: AuthedRequest) {
    return this.config.updateRewardCoins(body?.rewardCoins, req.user.userId);
  }
}
