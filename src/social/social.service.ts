import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async assertUserExists(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
  }

  async follow(followerId: string, followingId: string) {
    if (followerId === followingId) {
      throw new BadRequestException('Cannot follow yourself');
    }
    await this.assertUserExists(followingId);

    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: followerId, blockedId: followingId },
          { blockerId: followingId, blockedId: followerId },
        ],
      },
    });
    if (blocked) {
      throw new BadRequestException('Cannot follow — a block exists between these users');
    }

    try {
      await this.prisma.follow.create({ data: { followerId, followingId } });
    } catch {
      throw new ConflictException('Already following');
    }

    await this.notifications.create(followingId, 'FOLLOW', { followerId });

    return { following: true };
  }

  async unfollow(followerId: string, followingId: string) {
    await this.prisma.follow.deleteMany({ where: { followerId, followingId } });
    return { following: false };
  }

  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new BadRequestException('Cannot block yourself');
    }
    await this.assertUserExists(blockedId);

    await this.prisma.$transaction([
      this.prisma.block.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        update: {},
        create: { blockerId, blockedId },
      }),
      // Blocking severs any existing follow relationship in either direction.
      this.prisma.follow.deleteMany({
        where: {
          OR: [
            { followerId: blockerId, followingId: blockedId },
            { followerId: blockedId, followingId: blockerId },
          ],
        },
      }),
    ]);

    await this.audit.record({
      actorId: blockerId,
      action: 'social.block',
      targetType: 'user',
      targetId: blockedId,
    });

    return { blocked: true };
  }

  // GET /social/stats existed as dead code on the mobile client (called
  // an endpoint that was never actually built) — this is that endpoint,
  // built for real. "Fans" here means followers, matching the label the
  // Profile redesign uses; pkWins is a genuine count of settled battles
  // this user actually won, not a display-only number invented for the
  // UI — PKBattle.winnerId is the same real field pk.service.ts sets on
  // settlement.
  async unblock(blockerId: string, blockedId: string) {
    await this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
    return { blocked: false };
  }

  async getStats(userId: string) {
    const [following, followers, pkWins, pkLosses] = await Promise.all([
      this.prisma.follow.count({ where: { followerId: userId } }),
      this.prisma.follow.count({ where: { followingId: userId } }),
      this.prisma.pKBattle.count({ where: { winnerId: userId } }),
      // Settled battles this user took part in and did not win. A draw has no
      // winner, so it is neither a win nor a loss.
      this.prisma.pKBattle.count({
        where: {
          status: 'SETTLED',
          OR: [{ challengerId: userId }, { opponentId: userId }],
          AND: [{ winnerId: { not: null } }, { winnerId: { not: userId } }],
        },
      }),
    ]);
    return { following, followers, pkWins, pkLosses };
  }

  // block()/unblock() already existed and worked — nothing ever let a
  // user see who they'd actually blocked, which is what a real "manage
  // blocked users" section on Profile needs. Real display names, same
  // batch-lookup pattern used everywhere else in this backend.
  async listBlocked(blockerId: string) {
    const blocks = await this.prisma.block.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
    });
    if (blocks.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: blocks.map((b) => b.blockedId) } },
      select: { id: true, displayName: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));

    return blocks.map((b) => ({
      userId: b.blockedId,
      displayName: nameById.get(b.blockedId) ?? null,
      blockedAt: b.createdAt,
    }));
  }

  async mute(muterId: string, mutedId: string) {
    if (muterId === mutedId) {
      throw new BadRequestException('Cannot mute yourself');
    }
    await this.assertUserExists(mutedId);
    await this.prisma.mute.upsert({
      where: { muterId_mutedId: { muterId, mutedId } },
      update: {},
      create: { muterId, mutedId },
    });
    return { muted: true };
  }

  async unmute(muterId: string, mutedId: string) {
    await this.prisma.mute.deleteMany({ where: { muterId, mutedId } });
    return { muted: false };
  }

  async listFollowing(userId: string) {
    const rows = await this.prisma.follow.findMany({
      where: { followerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.followingId) } },
      select: { id: true, displayName: true, countryCode: true },
    });
    return users;
  }

  async listFollowers(userId: string) {
    const rows = await this.prisma.follow.findMany({
      where: { followingId: userId },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.followerId) } },
      select: { id: true, displayName: true, countryCode: true },
    });
    return users;
  }
}
