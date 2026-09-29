import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName } from '@prisma/client';
import { C2CService } from './c2c.service';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';

interface AuthedRequest extends Request { user: { userId: string }; }

@Controller('api/v1/c2c')
@UseGuards(JwtAuthGuard)
export class C2CController {
  constructor(private readonly c2c: C2CService) {}
  @Get('orders') list(@Req() req: AuthedRequest) { return this.c2c.listOpen(req.user.userId); }
  @Post('orders') @UseGuards(UserThrottlerGuard) @Throttle({ default: { limit: 20, ttl: 60_000 } }) create(@Body() b: any, @Req() req: AuthedRequest) { return this.c2c.create(req.user.userId, Number(b.coinAmount), b.fiatAmountMinor == null ? undefined : Number(b.fiatAmountMinor), b.currencyCode == null ? undefined : String(b.currencyCode), b.ttlMinutes == null ? undefined : Number(b.ttlMinutes)); }
  @Post('orders/:id/accept') @UseGuards(UserThrottlerGuard) @Throttle({ default: { limit: 30, ttl: 60_000 } }) accept(@Param('id') id: string, @Req() req: AuthedRequest) { return this.c2c.accept(id, req.user.userId); }
  @Post('orders/:id/payment') @UseGuards(UserThrottlerGuard) @Throttle({ default: { limit: 30, ttl: 60_000 } }) payment(@Param('id') id: string, @Body() b: any, @Req() req: AuthedRequest) { return this.c2c.submitPayment(req.user.userId, id, b.proofUrl, b.note, b.paymentReference); }
  @Post('orders/:id/release') @UseGuards(UserThrottlerGuard) @Throttle({ default: { limit: 30, ttl: 60_000 } }) release(@Param('id') id: string, @Req() req: AuthedRequest) { return this.c2c.release(req.user.userId, id); }
  @Post('orders/:id/cancel') @UseGuards(UserThrottlerGuard) @Throttle({ default: { limit: 30, ttl: 60_000 } }) cancel(@Param('id') id: string, @Req() req: AuthedRequest) { return this.c2c.cancel(req.user.userId, id); }
  @Post('orders/:id/dispute') @UseGuards(UserThrottlerGuard) @Throttle({ default: { limit: 10, ttl: 60_000 } }) dispute(@Param('id') id: string, @Body('reason') reason: string, @Req() req: AuthedRequest) { return this.c2c.dispute(req.user.userId, id, reason); }
  @Get('admin/orders') @UseGuards(RolesGuard) @Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN) adminList(@Query('status') status?: any) {
    if (status !== undefined && !['OPEN','ACCEPTED','PAYMENT_SUBMITTED','RELEASED','CANCELLED','DISPUTED','REFUNDED','EXPIRED'].includes(String(status))) throw new BadRequestException('Invalid C2C status');
    return this.c2c.adminList(status);
  }
  @Post('admin/:id/resolve') @UseGuards(RolesGuard) @Roles(RoleName.SUPER_ADMIN, RoleName.FINANCE_ADMIN) resolve(@Param('id') id: string, @Body() b: any, @Req() req: AuthedRequest) { return this.c2c.adminResolve(id, req.user.userId, b.action, b.note); }
}
