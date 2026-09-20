import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayoutQuote, PayoutRules, quoteWithdrawal, computePayout, validatePayoutConfig } from './payout-math';

export type PayoutUnavailableReason = 'NOT_CONFIGURED' | 'DISABLED';

@Injectable()
export class PayoutConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Every country's row, plus the countries that have none yet (so the admin
  // can set one up), so a new region never needs a code change to get a config.
  async listForAdmin() {
    const [configs, regions] = await Promise.all([
      this.prisma.payoutConfig.findMany({ orderBy: { countryCode: 'asc' } }),
      this.prisma.regionalConfig.findMany({ select: { countryCode: true, countryName: true, currencyCode: true, active: true } }),
    ]);
    const byCountry = new Map(configs.map((c) => [c.countryCode, c]));
    return regions
      .map((r) => ({
        countryCode: r.countryCode,
        countryName: r.countryName,
        regionActive: r.active,
        currencyCode: byCountry.get(r.countryCode)?.currencyCode ?? r.currencyCode,
        configured: byCountry.has(r.countryCode),
        config: byCountry.get(r.countryCode) ?? null,
      }))
      .sort((a, b) => a.countryCode.localeCompare(b.countryCode));
  }

  async upsert(countryCode: string, body: unknown, actorId: string, actorRoles: RoleName[]) {
    const code = countryCode.toUpperCase();
    const region = await this.prisma.regionalConfig.findUnique({ where: { countryCode: code } });
    if (!region) throw new NotFoundException('That country is not set up under Regions');
    const input = validatePayoutConfig(body);

    const before = await this.prisma.payoutConfig.findUnique({ where: { countryCode: code } });
    const saved = await this.prisma.payoutConfig.upsert({
      where: { countryCode: code },
      update: { ...input, updatedBy: actorId },
      create: { countryCode: code, currencyCode: region.currencyCode, ...input, updatedBy: actorId },
    });

    // Money rules are exactly what an audit trail is for: who changed what, from what.
    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: 'payout_config.update',
      targetType: 'payout_config',
      targetId: code,
      metadata: { before, after: saved } as any,
    });
    return saved;
  }

  // The rules a signed-in user is subject to (their own country's), or the
  // reason they can't withdraw. Includes only what the client needs to show.
  async forUser(countryCode: string) {
    const config = await this.prisma.payoutConfig.findUnique({ where: { countryCode: countryCode.toUpperCase() } });
    if (!config) return { available: false as const, reason: 'NOT_CONFIGURED' as PayoutUnavailableReason };
    if (!config.enabled) return { available: false as const, reason: 'DISABLED' as PayoutUnavailableReason, currencyCode: config.currencyCode };
    return {
      available: true as const,
      currencyCode: config.currencyCode,
      minorPer100Coins: config.minorPer100Coins,
      minWithdrawalCoins: config.minWithdrawalCoins,
      maxWithdrawalCoins: config.maxWithdrawalCoins,
      feeBps: config.feeBps,
      feeFlatMinor: config.feeFlatMinor,
      requireKyc: config.requireKyc,
    };
  }

  // A preview for the UI, computed here so the client never duplicates the math.
  // Does not enforce limits (a too-small amount still shows what it would pay).
  async preview(countryCode: string, coins: number) {
    const config = await this.prisma.payoutConfig.findUnique({ where: { countryCode: countryCode.toUpperCase() } });
    if (!config || !config.enabled) throw new BadRequestException('Withdrawals are not available in your country yet');
    if (!Number.isInteger(coins) || coins <= 0) throw new BadRequestException('coins must be a positive whole number');
    return { currencyCode: config.currencyCode, ...computePayout(coins, this.rules(config)) };
  }

  // The gate for a real withdrawal: the country must be enabled, and the amount
  // must satisfy the admin's limits. Returns the cash figures to snapshot.
  async requireQuote(countryCode: string, coins: number): Promise<PayoutQuote & { currencyCode: string; requireKyc: boolean }> {
    const config = await this.prisma.payoutConfig.findUnique({ where: { countryCode: countryCode.toUpperCase() } });
    if (!config || !config.enabled) throw new BadRequestException('Withdrawals are not available in your country yet');
    return { currencyCode: config.currencyCode, requireKyc: config.requireKyc, ...quoteWithdrawal(coins, this.rules(config)) };
  }

  private rules(c: { minorPer100Coins: number; minWithdrawalCoins: number; maxWithdrawalCoins: number | null; feeBps: number; feeFlatMinor: number }): PayoutRules {
    return {
      minorPer100Coins: c.minorPer100Coins,
      minWithdrawalCoins: c.minWithdrawalCoins,
      maxWithdrawalCoins: c.maxWithdrawalCoins,
      feeBps: c.feeBps,
      feeFlatMinor: c.feeFlatMinor,
    };
  }
}
