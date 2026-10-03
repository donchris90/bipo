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
    const countryCode = String(data.countryCode ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new BadRequestException('countryCode must be a 2-letter ISO country code');
    const countryName = String(data.countryName ?? '').trim();
    if (!countryName || countryName.length > 100) throw new BadRequestException('countryName is required (up to 100 characters)');
    const currencyCode = String(data.currencyCode ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) throw new BadRequestException('currencyCode must be a 3-letter ISO currency code');
    const defaultLanguage = String(data.defaultLanguage ?? '').trim();
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(defaultLanguage)) throw new BadRequestException('defaultLanguage must be a language code such as "en" or "fr-CA"');
    if (data.minAge !== undefined && (!Number.isInteger(Number(data.minAge)) || Number(data.minAge) < 13 || Number(data.minAge) > 99)) {
      throw new BadRequestException('minAge must be a whole number from 13 to 99');
    }
    const paymentMethods = Array.isArray(data.paymentMethods)
      ? [...new Set(data.paymentMethods.map((v) => String(v).toUpperCase()).filter((v) => ['PAYSTACK', 'CRYPTO'].includes(v)))]
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
    const clean = { ...data, countryCode, countryName, currencyCode, defaultLanguage, ...(paymentMethods ? { paymentMethods } : {}), creatorEarningMinorPer100Coins, coinUsdCentsPer100, c2cFiatMinorPer100Coins };
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
