import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { assertNotBlocked } from '../common/blocks';

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async send(senderId: string, recipientId: string, content: string) {
    if (senderId === recipientId) throw new BadRequestException("You can't message yourself");
    const trimmed = content?.trim();
    if (!trimmed) throw new BadRequestException('Message cannot be empty');
    if (trimmed.length > 2000) throw new BadRequestException('Message is too long');

    const recipient = await this.prisma.user.findUnique({ where: { id: recipientId }, select: { id: true } });
    if (!recipient) throw new NotFoundException('Recipient not found');

    // Either direction. Checked before anything is stored, pushed or
    // notified, so a blocked message leaves no trace. Existing history stays
    // readable — only new contact is stopped.
    await assertNotBlocked(this.prisma, senderId, recipientId, "You can't message this user");

    const message = await this.prisma.directMessage.create({
      data: { senderId, recipientId, content: trimmed },
    });

    // Push the message over the per-user socket room (the same one call
    // signaling uses) to the recipient — and to the sender's own sockets so
    // a second logged-in device stays in sync. Emitted right after the row
    // exists and before the notification write, so a notification failure
    // can't leave a stored message that was never delivered live. Best
    // effort: the row is the source of truth and clients keep a slow poll
    // (plus a refetch on socket reconnect) as the fallback.
    try {
      this.realtime.emitToUser(recipientId, 'dm:message', message);
      this.realtime.emitToUser(senderId, 'dm:message', message);
    } catch {
      /* delivered on the client's next fetch */
    }

    // Real notification on send, reusing the same real notifications
    // system built earlier — without this, a recipient would have no
    // signal a message arrived until they happened to open Messages.
    await this.notifications.create(recipientId, 'MESSAGE', { senderId });

    return message;
  }

  // New messages are pushed live as 'dm:message' (see send()); this and
  // getConversation() remain the source of truth the client loads on open
  // and refetches after a reconnect.
  //
  // "Conversations" aren't a stored table — deriving them from the real
  // messages avoids a second source of truth that could drift out of
  // sync with what was actually sent. Fetches every message involving
  // this user and reduces in application code rather than a Prisma
  // groupBy, since groupBy can't cheaply return "the full latest row per
  // counterpart" — a real tradeoff for a user's total DM volume staying
  // reasonable, not assumed to scale unboundedly.
  async listConversations(userId: string) {
    const messages = await this.prisma.directMessage.findMany({
      where: { OR: [{ senderId: userId }, { recipientId: userId }] },
      orderBy: { createdAt: 'desc' },
    });
    if (messages.length === 0) return [];

    const byOther = new Map<string, { lastMessage: (typeof messages)[number]; unreadCount: number }>();
    for (const m of messages) {
      const otherId = m.senderId === userId ? m.recipientId : m.senderId;
      if (!byOther.has(otherId)) {
        byOther.set(otherId, { lastMessage: m, unreadCount: 0 });
      }
      if (m.recipientId === userId && !m.read) {
        byOther.get(otherId)!.unreadCount++;
      }
    }

    const otherIds = [...byOther.keys()];
    const users = await this.prisma.user.findMany({
      where: { id: { in: otherIds } },
      select: { id: true, displayName: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));

    return otherIds
      .map((id) => {
        const entry = byOther.get(id)!;
        return {
          userId: id,
          displayName: nameById.get(id) ?? null,
          lastMessage: entry.lastMessage.content,
          lastMessageAt: entry.lastMessage.createdAt,
          lastMessageIsMine: entry.lastMessage.senderId === userId,
          unreadCount: entry.unreadCount,
        };
      })
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  }

  async getConversation(userId: string, otherUserId: string) {
    return this.prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: userId, recipientId: otherUserId },
          { senderId: otherUserId, recipientId: userId },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  async markConversationRead(userId: string, otherUserId: string) {
    await this.prisma.directMessage.updateMany({
      where: { senderId: otherUserId, recipientId: userId, read: false },
      data: { read: true },
    });
    return { read: true };
  }
}
