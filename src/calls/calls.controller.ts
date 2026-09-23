import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { CallsService } from './calls.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/calls')
@UseGuards(JwtAuthGuard)
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get('pricing')
  pricing() { return this.calls.getPricing(); }

  @Post()
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  initiate(@Body('calleeId') calleeId: string, @Req() req: AuthedRequest) {
    return this.calls.initiate(req.user.userId, calleeId);
  }

  @Get('history')
  history(@Req() req: AuthedRequest) { return this.calls.history(req.user.userId); }

  @Get(':id')
  getStatus(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.calls.getStatus(id, req.user.userId);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.calls.accept(id, req.user.userId);
  }

  @Post(':id/decline')
  decline(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.calls.decline(id, req.user.userId);
  }

  @Post(':id/start')
  start(@Param('id') id: string, @Req() req: AuthedRequest) { return this.calls.startBilling(id, req.user.userId); }

  @Post(':id/bill')
  bill(@Param('id') id: string, @Req() req: AuthedRequest) { return this.calls.bill(id, req.user.userId); }

  @Post(':id/end')
  end(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.calls.end(id, req.user.userId);
  }

  @Post(':id/join')
  join(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.calls.joinToken(id, req.user.userId);
  }
}


@Controller('api/v1/admin/calls')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN)
export class AdminCallsController {
  constructor(private readonly calls: CallsService) {}
  @Get('pricing') pricing() { return this.calls.getPricing(); }
  @Put('pricing') updatePricing(@Body() body: any, @Req() req: AuthedRequest) { return this.calls.updatePricing(body, req.user.userId); }
}
