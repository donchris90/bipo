import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
      creatorEarningMinorPer100Coins?: number | null;
      coinUsdCentsPer100?: number | null;
      c2cFiatMinorPer100Coins?: number | null;
      paymentMethods?: string[];
    },
    actorId: string,
    actorRoles: RoleName[],
  ) {
    const countryCode = data.countryCode.toUpperCase();
    const paymentMethods = Array.isArray(data.paymentMethods)
      ? [...new Set(data.paymentMethods.map((v) => String(v).toUpperCase()).filter((v) => ['PAYSTACK', 'CRYPTO', 'C2C'].includes(v)))]
      : undefined;
    const creatorEarningMinorPer100Coins = data.creatorEarningMinorPer100Coins == null ? data.creatorEarningMinorPer100Coins : Number(data.creatorEarningMinorPer100Coins);
    const coinUsdCentsPer100 = data.coinUsdCentsPer100 == null ? data.coinUsdCentsPer100 : Number(data.coinUsdCentsPer100);
    const c2cFiatMinorPer100Coins = data.c2cFiatMinorPer100Coins == null ? data.c2cFiatMinorPer100Coins : Number(data.c2cFiatMinorPer100Coins);
    if (creatorEarningMinorPer100Coins != null && (!Number.isInteger(creatorEarningMinorPer100Coins) || creatorEarningMinorPer100Coins < 0)) {
      throw new BadRequestException('creatorEarningMinorPer100Coins must be a non-negative whole number');
    }
    if (coinUsdCentsPer100 != null && (!Number.isInteger(coinUsdCentsPer100) || coinUsdCentsPer100 < 0)) {
      throw new BadRequestException('coinUsdCentsPer100 must be a non-negative whole number');
    }
    if (c2cFiatMinorPer100Coins != null && (!Number.isInteger(c2cFiatMinorPer100Coins) || c2cFiatMinorPer100Coins <= 0)) {
      throw new BadRequestException('c2cFiatMinorPer100Coins must be a positive whole number');
    }
    const clean = { ...data, countryCode, ...(paymentMethods ? { paymentMethods } : {}), creatorEarningMinorPer100Coins, coinUsdCentsPer100, c2cFiatMinorPer100Coins };
    const config = await this.prisma.regionalConfig.upsert({
      where: { countryCode },
      update: clean,
      create: clean,
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
