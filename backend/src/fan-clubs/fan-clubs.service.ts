import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupporterLevelsService } from '../supporters/supporter-levels.service';

@Injectable()
export class FanClubsService {
  constructor(private readonly prisma: PrismaService, private readonly supporterLevels: SupporterLevelsService) {}

  async me(userId: string, creatorId: string) {
    await this.assertCreator(creatorId);
    const [row, progress] = await Promise.all([
      this.prisma.creatorSupporter.findUnique({ where: { supporterId_creatorId: { supporterId: userId, creatorId } } }),
      this.supporterLevels.progress(userId, creatorId),
    ]);
    return {
      creatorId,
      joined: Boolean(row?.fanClubJoinedAt),
      joinedAt: row?.fanClubJoinedAt?.toISOString() ?? null,
      supporterLevel: progress,
      privileges: this.privileges(progress.level, Boolean(row?.fanClubJoinedAt)),
    };
  }

  async join(userId: string, creatorId: string) {
    if (userId === creatorId) throw new BadRequestException('You cannot join your own fan club');
    await this.assertCreator(creatorId);
    const row = await this.prisma.creatorSupporter.upsert({
      where: { supporterId_creatorId: { supporterId: userId, creatorId } },
      update: { fanClubJoinedAt: new Date() },
      create: { supporterId: userId, creatorId, fanClubJoinedAt: new Date() },
    });
    return { joined: true, joinedAt: row.fanClubJoinedAt };
  }

  async leave(userId: string, creatorId: string) {
    await this.assertCreator(creatorId);
    await this.prisma.creatorSupporter.updateMany({
      where: { supporterId: userId, creatorId },
      data: { fanClubJoinedAt: null },
    });
    return { joined: false };
  }

  private async assertCreator(creatorId: string) {
    const creator = await this.prisma.user.findFirst({
      where: { id: creatorId, status: 'ACTIVE' },
      select: { id: true, roles: { select: { role: true } } },
    });
    if (!creator) throw new NotFoundException('Creator not found');
    const isCreator = creator.roles.some((r) => r.role === 'CREATOR');
    if (!isCreator) throw new BadRequestException('Fan clubs are available for creators only');
  }

  private privileges(level: number, joined: boolean) {
    if (!joined) return [];
    const out = ['FAN_CLUB_MEMBER_BADGE'];
    if (level >= 3) out.push('SUPPORTER_LEVEL_BADGE');
    if (level >= 5) out.push('VIP_SUPPORTER_BADGE');
    return out;
  }
}
