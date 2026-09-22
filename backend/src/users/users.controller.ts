import { Controller, Body, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleName, UserStatus } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  me(@Req() req: AuthedRequest) {
    return this.usersService.findMe(req.user.userId);
  }

  @Get('me/referrals')
  myReferrals(@Req() req: AuthedRequest) {
    return this.usersService.findMyReferrals(req.user.userId);
  }

  @Get('me/check-in')
  checkInStatus(@Req() req: AuthedRequest) {
    return this.usersService.getCheckInStatus(req.user.userId);
  }

  @Post('me/check-in')
  checkIn(@Req() req: AuthedRequest) {
    return this.usersService.checkIn(req.user.userId);
  }

  @Patch('me')
  updateMe(
    @Body('displayName') displayName: string | undefined,
    @Body('avatarUrl') avatarUrl: string | undefined,
    @Body('bio') bio: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.updateMe(req.user.userId, { displayName, avatarUrl, bio });
  }

  @Patch(':id/suspend')
  @Roles(RoleName.TRUST_SAFETY_ADMIN, RoleName.SUPER_ADMIN)
  suspend(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.usersService.setStatus(id, UserStatus.SUSPENDED, req.user.userId, req.user.roles);
  }

  @Patch(':id/ban')
  @Roles(RoleName.TRUST_SAFETY_ADMIN, RoleName.SUPER_ADMIN)
  ban(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.usersService.setStatus(id, UserStatus.BANNED, req.user.userId, req.user.roles);
  }

  @Patch(':id/restore')
  @Roles(RoleName.TRUST_SAFETY_ADMIN, RoleName.SUPER_ADMIN)
  restore(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.usersService.setStatus(id, UserStatus.ACTIVE, req.user.userId, req.user.roles);
  }

  @Patch(':id/kyc')
  @Roles(RoleName.TRUST_SAFETY_ADMIN, RoleName.FINANCE_ADMIN, RoleName.SUPER_ADMIN)
  setKyc(@Param('id') id: string, @Body('verified') verified: boolean, @Req() req: AuthedRequest) {
    return this.usersService.setKycVerified(id, verified, req.user.userId, req.user.roles);
  }
}
