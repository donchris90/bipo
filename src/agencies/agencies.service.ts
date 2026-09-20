import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RoleName, WalletType, LedgerEntryType } from '@prisma/client';
import { periodStart, type AnalyticsPeriod } from '../creators/creator-analytics.service';

@Injectable()
export class AgenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  register(ownerId: string, name: string) {
    return this.prisma.agency.create({ data: { ownerId, name } });
  }

  async approve(agencyId: string, reviewerId: string, reviewerRoles: RoleName[]) {
    const agency = await this.prisma.agency.update({
      where: { id: agencyId },
      data: { status: 'APPROVED' },
    });
    await this.audit.record({
      actorId: reviewerId,
      actorRole: reviewerRoles[0],
      action: 'agency.approve',
      targetType: 'agency',
      targetId: agencyId,
    });
    return agency;
  }

  // Spec §34: "A creator should not belong to multiple agencies
  // simultaneously unless business rules explicitly support it." Enforced
  // here at the application level (see schema comment on AgencyMembership).
  async addCreator(agencyId: string, creatorId: string, commissionBps: number, actorId: string) {
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Agency not found');
    if (agency.status !== 'APPROVED') throw new BadRequestException('Agency is not approved');
    if (agency.ownerId !== actorId) throw new ForbiddenException('Only the agency owner can recruit creators');

    const activeElsewhere = await this.prisma.agencyMembership.findFirst({
      where: { creatorId, status: 'ACTIVE' },
    });
    if (activeElsewhere) throw new BadRequestException('Creator already has an active agency membership');

    return this.prisma.agencyMembership.create({
      data: { agencyId, creatorId, commissionBps },
    });
  }

  async removeCreator(agencyId: string, creatorId: string, actorId: string) {
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Agency not found');
    if (agency.ownerId !== actorId) throw new ForbiddenException('Only the agency owner can remove creators');

    await this.prisma.agencyMembership.updateMany({
      where: { agencyId, creatorId, status: 'ACTIVE' },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    return { removed: true };
  }

  listCreators(agencyId: string) {
    return this.prisma.agencyMembership.findMany({ where: { agencyId, status: 'ACTIVE' } });
  }

  // GET /agencies/me — a creator's own membership status. Returns null
  // rather than 404 when the creator isn't in an agency, since "not in an
  // agency" is a normal, expected state for most creators, not an error.
  // AgencyMembership has no direct Prisma relation to Agency (same
  // no-cross-domain-relations pattern used throughout this schema — see
  // RoomsService/GiftService for the same shape), so the agency name is
  // resolved with a second lookup rather than an include.
  async myMembership(creatorId: string) {
    const membership = await this.prisma.agencyMembership.findFirst({
      where: { creatorId, status: 'ACTIVE' },
      orderBy: { joinedAt: 'desc' },
    });
    if (!membership) return null;

    const agency = await this.prisma.agency.findUnique({ where: { id: membership.agencyId } });

    return {
      id: membership.id,
      agencyId: membership.agencyId,
      agencyName: agency?.name ?? null,
      commissionBps: membership.commissionBps,
      status: membership.status,
      joinedAt: membership.joinedAt,
    };
  }

  // The agency owner's dashboard, or null if the caller owns no agency (a
  // normal state for most users, so not a 404 — same convention as
  // myMembership()). Commission is already credited to the owner's
  // AGENCY_EARNINGS wallet in real time by GiftService, so "settlement" here
  // is just reading that wallet and its ledger; the owner can withdraw it via
  // POST /withdrawals { walletType: 'AGENCY_EARNINGS' }.
  //
  // Member figures are gifts received by *current* members over the window
  // (gross coins), not a per-member commission split — the ledger only
  // records the agency's total cut per gift.
  async ownerDashboard(ownerId: string, period: AnalyticsPeriod) {
    const owned = await this.prisma.agency.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' } });
    if (owned.length === 0) return null;
    const agency = owned.find((a) => a.status === 'APPROVED') ?? owned[0];

    const since = periodStart(period);
    const memberships = await this.prisma.agencyMembership.findMany({
      where: { agencyId: agency.id, status: 'ACTIVE' },
      orderBy: { joinedAt: 'asc' },
    });
    const creatorIds = memberships.map((m) => m.creatorId);

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_type: { userId: ownerId, type: WalletType.AGENCY_EARNINGS } },
      select: { id: true, balance: true },
    });

    const [commission, users, giftGroups] = await Promise.all([
      wallet
        ? this.prisma.ledgerEntry.aggregate({
            where: { walletId: wallet.id, type: LedgerEntryType.AGENCY_COMMISSION, createdAt: { gte: since } },
            _sum: { amount: true },
          })
        : Promise.resolve({ _sum: { amount: null as bigint | null } }),
      creatorIds.length
        ? this.prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, displayName: true } })
        : Promise.resolve([] as { id: string; displayName: string | null }[]),
      creatorIds.length
        ? this.prisma.giftTransaction.groupBy({
            by: ['recipientId'],
            where: { recipientId: { in: creatorIds }, createdAt: { gte: since } },
            _sum: { coinAmount: true },
          })
        : Promise.resolve([] as { recipientId: string; _sum: { coinAmount: number | null } }[]),
    ]);

    const nameById = new Map(users.map((u) => [u.id, u.displayName]));
    const coinsById = new Map(giftGroups.map((g) => [g.recipientId, g._sum.coinAmount ?? 0]));

    const members = memberships
      .map((m) => ({
        creatorId: m.creatorId,
        displayName: nameById.get(m.creatorId) ?? null,
        commissionBps: m.commissionBps,
        joinedAt: m.joinedAt,
        giftCoins: coinsById.get(m.creatorId) ?? 0,
      }))
      .sort((a, b) => b.giftCoins - a.giftCoins);

    return {
      agency: { id: agency.id, name: agency.name, status: agency.status },
      period,
      since,
      withdrawableBalance: (wallet?.balance ?? 0n).toString(),
      commissionCoins: (commission._sum.amount ?? 0n).toString(),
      memberCount: members.length,
      memberGiftCoins: members.reduce((sum, m) => sum + m.giftCoins, 0),
      members,
    };
  }

  // Commission settlement (spec §34 "receive commissions") requires reading
  // gift/creator-earnings ledger entries for each member creator over a
  // period and crediting an AGENCY_EARNINGS wallet with the agency's cut.
  // Not implemented — depends on deciding a settlement cadence (real-time
  // vs. batched daily/weekly) which is a product decision, not a technical
  // default worth guessing here.
}
