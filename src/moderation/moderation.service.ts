import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatContext } from '@prisma/client';

// RoomsService.muteGuest/banGuest already write ModerationAction rows —
// this is the read side those actions were missing. "Current state" is
// derived from the most recent action of the relevant pair (MUTE/UNMUTE,
// BAN/UNBAN) rather than a separate mutable status column, so the audit
// trail and the enforcement state can never drift apart.
@Injectable()
export class ModerationService {
  constructor(private readonly prisma: PrismaService) {}

  async isMuted(context: ChatContext, contextId: string, userId: string): Promise<boolean> {
    const latest = await this.prisma.moderationAction.findFirst({
      where: { context, contextId, targetUserId: userId, actionType: { in: ['MUTE', 'UNMUTE'] } },
      orderBy: { createdAt: 'desc' },
    });
    return latest?.actionType === 'MUTE';
  }

  // Everyone whose latest MUTE/UNMUTE action in this context is MUTE.
  // Replays the action log in order so the last action per user wins —
  // same "derive state from the audit trail" approach as isMuted().
  async mutedUserIds(context: ChatContext, contextId: string): Promise<string[]> {
    const actions = await this.prisma.moderationAction.findMany({
      where: { context, contextId, actionType: { in: ['MUTE', 'UNMUTE'] }, targetUserId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { targetUserId: true, actionType: true },
    });
    const muted = new Map<string, boolean>();
    for (const a of actions) muted.set(a.targetUserId as string, a.actionType === 'MUTE');
    return [...muted.entries()].filter(([, isMuted]) => isMuted).map(([id]) => id);
  }

  async isBanned(context: ChatContext, contextId: string, userId: string): Promise<boolean> {
    const latest = await this.prisma.moderationAction.findFirst({
      where: { context, contextId, targetUserId: userId, actionType: { in: ['BAN', 'UNBAN'] } },
      orderBy: { createdAt: 'desc' },
    });
    return latest?.actionType === 'BAN';
  }
}
