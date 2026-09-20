import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RegionalConfigService } from './regional-config.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

// Public bootstrap endpoint — the mobile app needs to know which
// countries/languages/currencies are active before a user is authenticated
// at all (e.g. the registration screen's country picker). No admin data
// (paymentsEnabled, gamesEnabled) is exposed here — see the admin
// controller below for that.
@Controller('api/v1/regions')
export class PublicRegionsController {
  constructor(private readonly service: RegionalConfigService) {}

  @Get()
  async listActive() {
    const all = await this.service.list();
    return all
      .filter((r) => r.active)
      .map((r) => ({
        countryCode: r.countryCode,
        countryName: r.countryName,
        currencyCode: r.currencyCode,
        defaultLanguage: r.defaultLanguage,
      }));
  }
}

@Controller('api/v1/admin/regional-config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RegionalConfigController {
  constructor(private readonly service: RegionalConfigService) {}

  @Get()
  @Roles(RoleName.SUPER_ADMIN, RoleName.GAME_OPERATOR, RoleName.FINANCE_ADMIN)
  list() {
    return this.service.list();
  }

  @Get(':countryCode')
  @Roles(RoleName.SUPER_ADMIN, RoleName.GAME_OPERATOR, RoleName.FINANCE_ADMIN)
  get(@Param('countryCode') countryCode: string) {
    return this.service.get(countryCode);
  }

  @Put(':countryCode')
  @Roles(RoleName.SUPER_ADMIN)
  upsert(
    @Param('countryCode') countryCode: string,
    @Body() body: any,
    @Req() req: AuthedRequest,
  ) {
    return this.service.upsert({ ...body, countryCode }, req.user.userId, req.user.roles);
  }
}
