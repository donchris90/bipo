import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isBlockedEitherWay } from '../common/blocks';
import { HostLevelsService } from '../host-levels/host-levels.service';

// One deliberately generic message for "no such person", "not available" and
// "blocked", so a profile lookup can't be used to learn who has blocked whom.
const NOT_FOUND = 'Profile not found';

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly hostLevels?: HostLevelsService,
  ) {}

  private async loadVisible(viewerId: string, targetId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, displayName: true, avatarUrl: true, countryCode: true, kycVerified: true, status: true, oneOnOneEnabled: true },
    });
    if (!user || user.status !== 'ACTIVE') throw new NotFoundException(NOT_FOUND);
    if (viewerId !== targetId && (await isBlockedEitherWay(this.prisma as any, viewerId, targetId))) throw new NotFoundException(NOT_FOUND);
    return user;
  }

  // What the profile card shows. Never an email, phone number or balance.
  async get(viewerId: string, targetId: string) {
    const user = await this.loadVisible(viewerId, targetId);
    const [followerCount, followingCount, follow, live, hostLevel] = await Promise.all([
      this.prisma.follow.count({ where: { followingId: targetId } }),
      this.prisma.follow.count({ where: { followerId: targetId } }),
      viewerId === targetId
        ? Promise.resolve(null)
        : this.prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: targetId } }, select: { followerId: true } }),
      this.prisma.liveSession.findFirst({ where: { hostId: targetId, status: 'LIVE' }, select: { id: true, title: true } }),
      this.hostLevels ? this.hostLevels.progress(targetId) : Promise.resolve({ xp: 0, level: 1, name: 'New Host', badgeUrl: null, unlocks: ['SOLO_LIVE'], nextLevel: null, progressXp: 0, requiredForNext: 0, remainingXp: 0 }),
    ]);
    return {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      countryCode: user.countryCode,
      verified: user.kycVerified,
      followerCount,
      followingCount,
      isMe: viewerId === targetId,
      isFollowing: !!follow,
      live: live ? { sessionId: live.id, title: live.title } : null,
      oneOnOneEnabled: !!user.oneOnOneEnabled,
      hostLevel,
    };
  }

  // Tells the person their profile was looked at. Once per visitor per person per
  // day (so opening a card ten times isn't ten notifications), never for your own
  // profile, never across a block, and in the inbox only — no phone buzz, because
  // a popular profile would otherwise notify all day.
  async recordView(viewerId: string, targetId: string, now = Date.now()) {
    if (viewerId === targetId) return { recorded: false };
    await this.loadVisible(viewerId, targetId);
    const visitor = await this.prisma.user.findUnique({ where: { id: viewerId }, select: { displayName: true, avatarUrl: true } });
    const day = new Date(now).toISOString().slice(0, 10);
    const created = await this.notifications.notifyOnce(targetId, 'PROFILE_VISIT', `visit:${viewerId}:${day}`, {
      visitorId: viewerId,
      visitorName: visitor?.displayName ?? null,
      visitorAvatarUrl: visitor?.avatarUrl ?? null,
    });
    return { recorded: !!created };
  }
}
