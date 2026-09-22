import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/guards/user-throttler.guard';
import { Request } from 'express';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';

interface AuthedRequest extends Request {
  user: { userId: string; roles: RoleName[]; countryCode: string };
}

@Controller('api/v1/messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  send(@Body('recipientId') recipientId: string, @Body('content') content: string, @Req() req: AuthedRequest) {
    return this.messages.send(req.user.userId, recipientId, content);
  }

  @Get('conversations')
  listConversations(@Req() req: AuthedRequest) {
    return this.messages.listConversations(req.user.userId);
  }

  @Get('with/:userId')
  getConversation(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.messages.getConversation(req.user.userId, userId);
  }

  @Patch('with/:userId/read')
  markRead(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.messages.markConversationRead(req.user.userId, userId);
  }
}
