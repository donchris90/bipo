import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';
import { RoomPkService } from './room-pk.service';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

// Multi-guest / Room PK. Same base path as RoomsController; the ':id/pk' routes don't collide
// with any of its routes.
@Controller('api/v1/rooms')
@UseGuards(JwtAuthGuard)
export class RoomPkController {
  constructor(private readonly roomPk: RoomPkService) {}

  // Host starts a PK between everyone currently seated. Body: { mode?: 'INDIVIDUAL'|'TEAMS',
  // durationSec?: 180|300|600|900, sides?: { "<seatNumber>": "A"|"B" } }
  @Post(':id/pk')
  start(
    @Param('id') id: string,
    @Body() body: { mode?: unknown; durationSec?: unknown; sides?: Record<string, unknown> | null },
    @Req() req: AuthedRequest,
  ) {
    return this.roomPk.start(id, req.user.userId, body ?? {});
  }

  // The running PK, or one that ended in the last 30 seconds, or null.
  @Get(':id/pk')
  current(@Param('id') id: string) {
    return this.roomPk.current(id);
  }

  @Post(':id/pk/end')
  end(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.roomPk.end(id, req.user.userId);
  }
}
