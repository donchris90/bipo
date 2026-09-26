import { BadRequestException } from '@nestjs/common';
import { ChatContext } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { publicName } from './public-name';
import { topBadgesFor, type BadgeSummary } from '../badges/badge-lookup';

export interface ChatHistoryItem {
  id: string;
  senderId: string;
  senderName: string | null;
  // The one badge (if any) that shows beside this sender's name — see badge-lookup.ts.
  senderBadge: BadgeSummary | null;
  content: string;
  createdAt: Date;
}

// Shared by GET /live/:id/chat and GET /rooms/:id/chat so both contexts
// return the exact same shape the realtime 'chat:message' event carries.
// Returns the most recent `limit` messages in ascending (oldest-first)
// order — what a chat overlay renders directly. Pass `before` (an ISO
// timestamp, typically the createdAt of the oldest message already on
// screen) to page further back.
export async function fetchChatHistory(
  prisma: PrismaService,
  context: ChatContext,
  contextId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ChatHistoryItem[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50) || 50, 1), 100);

  let beforeDate: Date | undefined;
  if (opts.before) {
    beforeDate = new Date(opts.before);
    if (Number.isNaN(beforeDate.getTime())) {
      throw new BadRequestException('before must be an ISO timestamp');
    }
  }

  const rows = await prisma.chatMessage.findMany({
    where: { context, contextId, ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  if (rows.length === 0) return [];

  const senderIds = [...new Set(rows.map((r) => r.senderId))];
  const [senders, badgesById] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, displayName: true } }),
    topBadgesFor(prisma, senderIds).catch(() => new Map<string, BadgeSummary>()),
  ]);
  const nameById = new Map(senders.map((u) => [u.id, u.displayName]));

  return rows.reverse().map((r) => ({
    id: r.id,
    senderId: r.senderId,
    senderName: publicName(nameById.get(r.senderId), r.senderId),
    senderBadge: badgesById.get(r.senderId) ?? null,
    content: r.content,
    createdAt: r.createdAt,
  }));
}
