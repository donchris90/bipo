import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RrydaLevelsService } from './rryda-levels.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

interface AuthedRequest extends Request {
  user: { userId: string };
}

@Controller('api/v1/users/me/rryda-level')
@UseGuards(JwtAuthGuard)
export class RrydaLevelsController {
  constructor(private readonly rrydaLevels: RrydaLevelsService) {}

  @Get()
  progress(@Req() req: AuthedRequest) {
    return this.rrydaLevels.progress(req.user.userId);
  }
}
