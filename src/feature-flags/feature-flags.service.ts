import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RoleName } from '@prisma/client';

// Well-known emergency flags from spec §84. Modules should check these
// before allowing writes (payments, withdrawals, games, gifts, registration,
// live) — this is the kill-switch layer, not a general A/B flag system.
export const KNOWN_FLAGS = [
  'DISABLE_PAYMENTS',
  'DISABLE_WITHDRAWALS',
  'DISABLE_GAMES',
  'DISABLE_GIFTS',
  'DISABLE_NEW_REGISTRATION',
  'DISABLE_LIVE',
] as const;

@Injectable()
export class FeatureFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async isEnabled(key: string): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    return !!flag?.enabled;
  }

  list() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async set(key: string, enabled: boolean, actorId: string, actorRoles: RoleName[]) {
    const flag = await this.prisma.featureFlag.upsert({
      where: { key },
      update: { enabled, updatedBy: actorId },
      create: { key, enabled, updatedBy: actorId },
    });

    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: 'feature_flag.set',
      targetType: 'feature_flag',
      targetId: key,
      metadata: { enabled },
    });

    return flag;
  }
}
