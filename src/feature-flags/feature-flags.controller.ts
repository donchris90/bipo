import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { FeatureFlagsService } from './feature-flags.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/admin/feature-flags')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class FeatureFlagsController {
  constructor(private readonly service: FeatureFlagsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Put(':key')
  set(@Param('key') key: string, @Body('enabled') enabled: boolean, @Req() req: AuthedRequest) {
    return this.service.set(key, enabled, req.user.userId, req.user.roles);
  }
}
