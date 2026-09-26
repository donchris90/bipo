import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationType } from '@prisma/client';

// A single announcement can reach a lot of people (a popular host's followers), so this is fired
// with `void` from the caller and never awaited — going live or opening a room must never wait on
// notifying anyone, and a failure here must never fail that action. Capped rather than queued: the
// existing notification/push path (NotificationsService.notify) is a plain per-user DB write plus
// a best-effort push, with no batch or background-job variant elsewhere in this codebase (the only
// job queue here is PK/game round transitions) — looping it a few hundred times inline is
// consistent with that, but a host with a much larger following would need a real queue instead of
// this cap.
const FOLLOWER_FANOUT_CAP = 500;

export async function announceToFollowersAndAgency(
  prisma: PrismaService,
  notifications: NotificationsService,
  hostId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const [followers, membership] = await Promise.all([
      prisma.follow.findMany({
        where: { followingId: hostId },
        orderBy: { createdAt: 'desc' },
        take: FOLLOWER_FANOUT_CAP,
        select: { followerId: true },
      }),
      prisma.agencyMembership.findFirst({
        where: { creatorId: hostId, status: 'ACTIVE' },
        select: { agencyId: true },
      }),
    ]);

    const recipients = new Set(followers.map((f) => f.followerId));

    if (membership) {
      const agencyMates = await prisma.agencyMembership.findMany({
        where: { agencyId: membership.agencyId, status: 'ACTIVE', creatorId: { not: hostId } },
        select: { creatorId: true },
      });
      for (const m of agencyMates) recipients.add(m.creatorId);
    }

    recipients.delete(hostId); // defensive: a host can't have followed or joined an agency with themself, but never notify them about their own activity either way

    await Promise.all([...recipients].map((userId) => notifications.notify(userId, type, payload)));
  } catch {
    /* an announcement is a nice-to-have; it must never affect going live or opening a room */
  }
}
