import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RoleName } from '@prisma/client';

@Injectable()
export class RegionalConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.regionalConfig.findMany({ orderBy: { countryCode: 'asc' } });
  }

  async get(countryCode: string) {
    const config = await this.prisma.regionalConfig.findUnique({
      where: { countryCode: countryCode.toUpperCase() },
    });
    if (!config) throw new NotFoundException('Country not configured');
    return config;
  }

  // Convenience used by future modules (games, payments) to hard-gate a
  // feature by country. Callers must check this server-side — never rely on
  // the client to hide a disabled feature.
  async isGamesEnabled(countryCode: string): Promise<boolean> {
    const config = await this.prisma.regionalConfig.findUnique({
      where: { countryCode: countryCode.toUpperCase() },
    });
    return !!config?.active && !!config?.gamesEnabled;
  }

  async upsert(
    data: {
      countryCode: string;
      countryName: string;
      currencyCode: string;
      defaultLanguage: string;
      minAge?: number;
      gamesEnabled?: boolean;
      paymentsEnabled?: boolean;
      active?: boolean;
    },
    actorId: string,
    actorRoles: RoleName[],
  ) {
    const countryCode = data.countryCode.toUpperCase();
    const config = await this.prisma.regionalConfig.upsert({
      where: { countryCode },
      update: { ...data, countryCode },
      create: { ...data, countryCode },
    });

    // Flipping gamesEnabled/paymentsEnabled is a legal/financial decision,
    // not a routine config change — audit it distinctly.
    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: 'regional_config.upsert',
      targetType: 'regional_config',
      targetId: countryCode,
      metadata: data,
    });

    return config;
  }
}
