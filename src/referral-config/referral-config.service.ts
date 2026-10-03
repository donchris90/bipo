import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export const DEFAULT_REFERRAL_REWARD_COINS = 100;
export const MAX_REFERRAL_REWARD_COINS = 100_000;

export function parseReferralReward(raw: unknown): number {
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isInteger(n) || n < 0 || n > MAX_REFERRAL_REWARD_COINS) {
    throw new BadRequestException(`rewardCoins must be a whole number between 0 and ${MAX_REFERRAL_REWARD_COINS}`);
  }
  return n;
}

// Referral reward is always paid to the BONUS wallet (never COIN or earnings);
// this service only controls the AMOUNT. Falls back to the default if the row
// is missing so signup never breaks on an unmigrated database.
@Injectable()
export class ReferralConfigService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async getRewardCoins(): Promise<number> {
    try {
      const row = await this.prisma.referralConfig.findUnique({ where: { id: 'global' } });
      return row?.rewardCoins ?? DEFAULT_REFERRAL_REWARD_COINS;
    } catch {
      return DEFAULT_REFERRAL_REWARD_COINS;
    }
  }

  async getConfig() {
    const row = await this.prisma.referralConfig.findUnique({ where: { id: 'global' } });
    return { rewardCoins: row?.rewardCoins ?? DEFAULT_REFERRAL_REWARD_COINS, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
  }

  async updateRewardCoins(input: unknown, actorId: string) {
    const rewardCoins = parseReferralReward(input);
    const before = await this.getRewardCoins();
    const row = await this.prisma.referralConfig.upsert({
      where: { id: 'global' },
      update: { rewardCoins, updatedBy: actorId },
      create: { id: 'global', rewardCoins, updatedBy: actorId },
    });
    await this.audit.record({
      actorId, action: 'referral.reward_updated', targetType: 'referral_config', targetId: 'global',
      metadata: { before, after: rewardCoins },
    });
    return { rewardCoins: row.rewardCoins, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
  }
}
