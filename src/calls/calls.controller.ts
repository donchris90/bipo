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

  // Declared before ':id' routes so 'my-pricing' / 'pricing/:hostId' are never read as a call id.
  @Get('my-pricing')
  myPricing(@Req() req: AuthedRequest) { return this.calls.myPricing(req.user.userId); }

  @Put('my-pricing')
  updateMyPricing(@Body() body: { audioPricePerMinute?: unknown; videoPricePerMinute?: unknown }, @Req() req: AuthedRequest) {
    return this.calls.updateMyPricing(req.user.userId, body ?? {});
  }

  @Get('pricing/:hostId')
  hostPricing(@Param('hostId') hostId: string) { return this.calls.hostPricing(hostId); }

  @Post()
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  initiate(@Body('calleeId') calleeId: string, @Body('mediaType') mediaType: string | undefined, @Req() req: AuthedRequest) {
    return this.calls.initiate(req.user.userId, calleeId, mediaType);
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
