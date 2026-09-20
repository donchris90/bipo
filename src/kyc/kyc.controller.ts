import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { KycService } from './kyc.service';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[] };
}

@Controller('api/v1/kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  status(@Req() req: AuthedRequest) {
    return this.kyc.statusFor(req.user.userId);
  }

  // Photos travel in the JSON body (base64), so this is rate-limited hard.
  @Post()
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  submit(@Body() body: any, @Req() req: AuthedRequest) {
    return this.kyc.submit(req.user.userId, {
      fullName: body?.fullName,
      dateOfBirth: body?.dateOfBirth,
      idType: body?.idType,
      idNumber: body?.idNumber,
      idImage: body?.idImage,
      selfieImage: body?.selfieImage,
    });
  }
}

@Controller('api/v1/admin/kyc')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SUPER_ADMIN, RoleName.TRUST_SAFETY_ADMIN)
export class KycAdminController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  list(@Query() q: Record<string, unknown>) {
    return this.kyc.list(q);
  }

  @Get(':id/image/:kind')
  async image(@Param('id') id: string, @Param('kind') kind: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const doc = await this.kyc.document(id, kind, req.user.userId, req.user.roles);
    res.setHeader('Content-Type', doc.contentType);
    // Identity documents must never be cached or sniffed.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(doc.data);
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.kyc.approve(id, req.user.userId, req.user.roles);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body('reason') reason: string, @Req() req: AuthedRequest) {
    return this.kyc.reject(id, req.user.userId, req.user.roles, reason);
  }
}
