import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { evaluateWithdrawalRisk, RiskResult } from './risk-rules';

const SHARED_IP_LOOKBACK_DAYS = 30;

@Injectable()
export class RiskService {
  constructor(private readonly prisma: PrismaService) {}

  // `walletType` is the wallet being withdrawn from — lifetime-earned is
  // measured against that same wallet, so an agency owner's withdrawal is
  // judged against agency earnings, not (empty) creator earnings.
  async scoreWithdrawal(
    userId: string,
    amountCoins: number,
    walletType: 'CREATOR_EARNINGS' | 'AGENCY_EARNINGS' = 'CREATOR_EARNINGS',
  ): Promise<RiskResult> {
    const [user, withdrawalsLast24h, lifetimeEarned, chargebackCount, sharedIpAccountCount] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.prisma.withdrawalRequest.count({
        where: { creatorId: userId, requestedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
      this.lifetimeEarnedCoins(userId, walletType),
      this.prisma.chargeback.count({ where: { userId } }),
      this.sharedIpAccountCount(userId),
    ]);

    const accountAgeDays = (Date.now() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000);

    return evaluateWithdrawalRisk({
      accountAgeDays,
      kycVerified: user.kycVerified,
      withdrawalsLast24h,
      amountCoins,
      lifetimeEarnedCoins: lifetimeEarned,
      chargebackCount,
      sharedIpAccountCount,
    });
  }

  private async lifetimeEarnedCoins(userId: string, walletType: 'CREATOR_EARNINGS' | 'AGENCY_EARNINGS'): Promise<number> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_type: { userId, type: walletType } },
    });
    if (!wallet) return 0;
    // Sum of positive ledger entries against this wallet — total ever
    // earned, not current balance (which is reduced by prior withdrawals).
    const positiveEntries = await this.prisma.ledgerEntry.aggregate({
      where: { walletId: wallet.id, amount: { gt: 0 } },
      _sum: { amount: true },
    });
    return Number(positiveEntries._sum.amount ?? 0n);
  }

  // Distinct other accounts seen at this user's most recent login IP,
  // within the lookback window. A rough multi-accounting/farming signal —
  // not a real device fingerprint, just IP overlap, so it's a fairly weak
  // signal on its own (shared networks, NAT, mobile carriers all produce
  // false positives) and is only one of several inputs, not a sole trigger.
  private async sharedIpAccountCount(userId: string): Promise<number> {
    const lastLogin = await this.prisma.loginEvent.findFirst({
      where: { userId, ipAddress: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!lastLogin?.ipAddress) return 0;

    const since = new Date(Date.now() - SHARED_IP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const others = await this.prisma.loginEvent.findMany({
      where: { ipAddress: lastLogin.ipAddress, userId: { not: userId }, createdAt: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
    });
    return others.length;
  }
}
