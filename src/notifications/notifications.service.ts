import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PushService } from './push.service';
import { describeForPush } from './push-messages';

// Gifts arrive in bursts (a busy live room can produce hundreds a minute),
// so a notification per gift would bury everything else. Gifts from the same
// sender are folded into one unread notification while the gifter keeps
// going, and a new one starts after a quiet gap.
const GIFT_COALESCE_MS = 10 * 60_000;

export interface GiftNotificationPayload {
  senderId: string;
  senderDisplayName: string | null;
  count: number;
  totalCoins: number;
}

// Pure and exported so the folding arithmetic has a direct test.
export function mergeGiftPayload(
  previous: Partial<GiftNotificationPayload> | null | undefined,
  base: { senderId: string; senderDisplayName: string | null },
  coinAmount: number,
): GiftNotificationPayload {
  return {
    senderId: base.senderId,
    senderDisplayName: base.senderDisplayName,
    count: (previous?.count ?? 0) + 1,
    totalCoins: (previous?.totalCoins ?? 0) + coinAmount,
  };
}

// In-app notifications, plus a live 'notification:new' nudge over the
// recipient's socket so the inbox updates without waiting for its poll.
// Push (FCM/APNs) and email are still separate provider integrations —
// create() remains the single seam they'll hook into.
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
  ) {}

  // Throws if the write fails — used by callers where the notification is
  // part of the request (follow, message). For anything triggered as a side
  // effect of something more important (money, game state), use notify() /
  // notifyOnce(), which can never fail the operation that caused them.
  async create(userId: string, type: NotificationType, payload?: Record<string, unknown>) {
    const notification = await this.prisma.notification.create({
      data: { userId, type, payload: payload as any },
    });
    this.nudge(userId, notification.id, type, notification.createdAt);
    void this.pushToPhone(userId, type, payload); // fire-and-forget; never rejects
    return notification;
  }

  // Best-effort: swallows and logs failures. A withdrawal, purchase or PK
  // settlement must never fail or roll back because a notification couldn't
  // be written.
  async notify(userId: string, type: NotificationType, payload?: Record<string, unknown>) {
    try {
      return await this.create(userId, type, payload);
    } catch (e: any) {
      this.logger.warn(`Could not create ${type} notification for ${userId}: ${e?.message ?? e}`);
      return null;
    }
  }

  // Like notify(), but at most once per `dedupeKey` for this user and type —
  // for events that can be reported twice (a webhook that fires twice, a
  // settle job racing a manual call). The key is stored in the payload.
  // Best-effort like notify(); a concurrent double-fire can in principle
  // still slip through, which for a notification is an acceptable edge.
  async notifyOnce(userId: string, type: NotificationType, dedupeKey: string, payload: Record<string, unknown> = {}) {
    try {
      const existing = await this.prisma.notification.findFirst({
        where: { userId, type, payload: { path: ['dedupeKey'], equals: dedupeKey } },
        select: { id: true },
      });
      if (existing) return null;
      return await this.create(userId, type, { ...payload, dedupeKey });
    } catch (e: any) {
      this.logger.warn(`Could not create ${type} notification for ${userId}: ${e?.message ?? e}`);
      return null;
    }
  }

  async notifyGift(recipientId: string, sender: { id: string; displayName: string | null }, coinAmount: number) {
    try {
      const since = new Date(Date.now() - GIFT_COALESCE_MS);
      const existing = await this.prisma.notification.findFirst({
        where: {
          userId: recipientId,
          type: 'GIFT_RECEIVED',
          read: false,
          createdAt: { gte: since },
          payload: { path: ['senderId'], equals: sender.id },
        },
        orderBy: { createdAt: 'desc' },
      });

      const base = { senderId: sender.id, senderDisplayName: sender.displayName };
      if (existing) {
        // Bump createdAt so it rises to the top and the quiet-gap window
        // measures from the latest gift, not the first.
        const updated = await this.prisma.notification.update({
          where: { id: existing.id },
          data: {
            payload: mergeGiftPayload(existing.payload as Partial<GiftNotificationPayload>, base, coinAmount) as any,
            createdAt: new Date(),
          },
        });
        // Socket nudge only — no phone push for a folded gift, or a busy
        // room would buzz the host's lock screen on every single gift.
        this.nudge(recipientId, updated.id, 'GIFT_RECEIVED', updated.createdAt);
        return updated;
      }
      return await this.create(recipientId, 'GIFT_RECEIVED', mergeGiftPayload(null, base, coinAmount) as any);
    } catch (e: any) {
      this.logger.warn(`Could not create gift notification for ${recipientId}: ${e?.message ?? e}`);
      return null;
    }
  }

  // Phone push, for people who aren't in the app. Skipped when they have a
  // live socket (the in-app nudge already reached them). Best-effort in every
  // way: a failure here can never affect the notification or the event that
  // caused it.
  private async pushToPhone(userId: string, type: NotificationType, payload?: Record<string, unknown>) {
    try {
      if (await this.realtime.isUserOnline(userId)) return;

      const p = (payload ?? {}) as Record<string, any>;
      const names: { follower?: string | null; sender?: string | null } = {};
      if (type === 'FOLLOW' && p.followerId) {
        names.follower = (await this.prisma.user.findUnique({ where: { id: p.followerId }, select: { displayName: true } }))?.displayName;
      }
      if (type === 'MESSAGE' && p.senderId) {
        names.sender = (await this.prisma.user.findUnique({ where: { id: p.senderId }, select: { displayName: true } }))?.displayName;
      }

      const content = describeForPush(type, p, names);
      if (!content) return;

      // `type` plus the payload (minus internal keys) let the app route a tap
      // to the right screen, the same way tapping the inbox row does.
      const { dedupeKey: _dedupeKey, ...data } = p;
      await this.push.sendToUser(userId, { ...content, data: { type, ...data } });
    } catch (e: any) {
      this.logger.warn(`Could not send phone push for ${type} to ${userId}: ${e?.message ?? e}`);
    }
  }

  // Counts for the tab-bar badge, without shipping whole lists to the client.
  // Every DM also creates a MESSAGE notification, so those are excluded from
  // the notification count — otherwise each unread message would be counted
  // twice (once as a notification, once as an unread message).
  async unreadCounts(userId: string) {
    const [notifications, messages] = await Promise.all([
      this.prisma.notification.count({ where: { userId, read: false, type: { not: 'MESSAGE' } } }),
      this.prisma.directMessage.count({ where: { recipientId: userId, read: false } }),
    ]);
    return { notifications, messages, total: notifications + messages };
  }

  private nudge(userId: string, id: string, type: NotificationType, createdAt: Date) {
    try {
      this.realtime.emitToUser(userId, 'notification:new', { id, type, createdAt });
    } catch {
      /* the inbox poll picks it up */
    }
  }

  // FOLLOW is the only type whose payload holds a raw id with no name (see
  // social.service.ts) — resolved here with the same batch-lookup pattern
  // used everywhere else in this backend rather than leaving the client to
  // make N follow-up requests. Every newer type snapshots the names it
  // needs into its payload when it is created.
  async list(userId: string, unreadOnly = false) {
    const notifications = await this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { read: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const followerIds = notifications
      .filter((n) => n.type === 'FOLLOW')
      .map((n) => (n.payload as any)?.followerId)
      .filter(Boolean);
    if (followerIds.length === 0) return notifications;

    const followers = await this.prisma.user.findMany({
      where: { id: { in: followerIds } },
      select: { id: true, displayName: true },
    });
    const nameById = new Map(followers.map((f) => [f.id, f.displayName]));

    return notifications.map((n) => {
      if (n.type !== 'FOLLOW') return n;
      const followerId = (n.payload as any)?.followerId;
      return { ...n, payload: { ...(n.payload as object), followerDisplayName: nameById.get(followerId) ?? null } };
    });
  }

  async markRead(userId: string, notificationId: string) {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true },
    });
    return { read: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { read: true };
  }
}
