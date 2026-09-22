import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RoleName, RegionalConfig } from '@prisma/client';

@Injectable()
export class CreatorApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async apply(userId: string) {
    const pending = await this.prisma.creatorApplication.findFirst({
      where: { userId, status: 'PENDING' },
    });
    if (pending) return pending;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.roles.some((r) => r.role === 'CREATOR')) {
      throw new BadRequestException('Already a creator');
    }

    const regionalConfig = await this.prisma.regionalConfig.findUnique({
      where: { countryCode: user.countryCode },
    });
    this.assertAgeEligible(user, regionalConfig);

    return this.prisma.creatorApplication.create({ data: { userId } });
  }

  private assertAgeEligible(user: { countryCode: string }, config: RegionalConfig | null) {
    // Actual date-of-birth / age verification is a KYC integration — not
    // built here. This only checks that the country itself is configured;
    // real age verification must happen before this ever reaches PENDING.
    if (!config || !config.active) {
      throw new BadRequestException('Creator program is not available in this country yet');
    }
  }

  async review(applicationId: string, approve: boolean, reviewerId: string, reviewerRoles: RoleName[], reason?: string) {
    const application = await this.prisma.creatorApplication.findUnique({ where: { id: applicationId } });
    if (!application) throw new NotFoundException('Application not found');
    if (application.status !== 'PENDING') throw new BadRequestException('Application already reviewed');

    const updated = await this.prisma.creatorApplication.update({
      where: { id: applicationId },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reason,
      },
    });

    if (approve) {
      await this.prisma.userRole.upsert({
        where: { userId_role: { userId: application.userId, role: 'CREATOR' } },
        update: {},
        create: { userId: application.userId, role: 'CREATOR' },
      });
    }

    await this.audit.record({
      actorId: reviewerId,
      actorRole: reviewerRoles[0],
      action: `creator_application.${approve ? 'approve' : 'reject'}`,
      targetType: 'creator_application',
      targetId: applicationId,
      metadata: { reason },
    });

    // The applicant has no other way to learn the outcome. A rejection
    // carries the reviewer's reason.
    await this.notifications.notifyOnce(application.userId, 'CREATOR_APPLICATION', `creator_app:${applicationId}`, {
      applicationId,
      status: approve ? 'APPROVED' : 'REJECTED',
      reason: approve ? undefined : reason,
    });

    return updated;
  }
}
