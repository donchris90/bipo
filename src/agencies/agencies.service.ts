import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RoleName, WalletType, LedgerEntryType } from '@prisma/client';
import { periodStart, type AnalyticsPeriod } from '../creators/creator-analytics.service';

export const DEFAULT_AGENCY_MIN_LEVEL = 10;

@Injectable()
export class AgenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // The gift split (computeGiftSplit) throws outside 0..10000 bps, so an unchecked value here
  // would make every later gift to that creator fail. Validate at the door.
  private assertCommission(bps: unknown): number {
    if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new BadRequestException('commissionBps must be a whole number between 0 and 10000 (100 = 1%)');
    }
    return bps;
  }

  private async isCreator(userId: string) {
    return !!(await this.prisma.userRole.findFirst({ where: { userId, role: RoleName.CREATOR }, select: { id: true } }));
  }

  private cleanName(rawName: unknown): string {
    const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 3 || name.length > 60) throw new BadRequestException('Agency name must be 3-60 characters');
    return name;
  }

  async getMinLevel(): Promise<number> {
    try {
      const row = await this.prisma.agencyConfig.findUnique({ where: { id: 'global' } });
      return row?.minRrydaLevel ?? DEFAULT_AGENCY_MIN_LEVEL;
    } catch {
      return DEFAULT_AGENCY_MIN_LEVEL;
    }
  }

  // Whether the caller can create an agency themselves, and what's in the way.
  async eligibility(userId: string) {
    const [minLevel, user, owned] = await Promise.all([
      this.getMinLevel(),
      this.prisma.user.findUnique({ where: { id: userId }, select: { rrydaLevel: true } }),
      this.prisma.agency.findFirst({ where: { ownerId: userId, status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true } }),
    ]);
    const level = user?.rrydaLevel ?? 1;
    return { minLevel, level, levelReached: level >= minLevel, alreadyOwns: !!owned, canCreate: level >= minLevel && !owned };
  }

  async getConfig() {
    const row = await this.prisma.agencyConfig.findUnique({ where: { id: 'global' } });
    return { minRrydaLevel: row?.minRrydaLevel ?? DEFAULT_AGENCY_MIN_LEVEL, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
  }

  async updateConfig(rawLevel: unknown, actorId: string, actorRoles: RoleName[]) {
    const minRrydaLevel = Number(rawLevel);
    if (rawLevel === null || rawLevel === undefined || rawLevel === '' || !Number.isInteger(minRrydaLevel) || minRrydaLevel < 1 || minRrydaLevel > 1000) {
      throw new BadRequestException('minRrydaLevel must be a whole number between 1 and 1000');
    }
    const before = await this.getMinLevel();
    const row = await this.prisma.agencyConfig.upsert({
      where: { id: 'global' },
      update: { minRrydaLevel, updatedBy: actorId },
      create: { id: 'global', minRrydaLevel, updatedBy: actorId },
    });
    await this.audit.record({
      actorId, actorRole: actorRoles[0], action: 'agency.min_level_updated', targetType: 'agency_config', targetId: 'global',
      metadata: { before, after: minRrydaLevel },
    });
    return { minRrydaLevel: row.minRrydaLevel, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
  }

  // Admin override: make ANY user an agency owner, already approved, whatever their level.
  async adminCreate(actorId: string, actorRoles: RoleName[], ownerId: unknown, rawName: unknown) {
    if (typeof ownerId !== 'string' || !ownerId) throw new BadRequestException('ownerId is required');
    const name = this.cleanName(rawName);
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, displayName: true } });
    if (!owner) throw new NotFoundException('User not found');
    const existing = await this.prisma.agency.findFirst({ where: { ownerId, status: { in: ['PENDING', 'APPROVED'] } } });

    let agency;
    if (existing && existing.status === 'PENDING') {
      // They already applied: approve that one instead of creating a second.
      agency = await this.prisma.agency.update({ where: { id: existing.id }, data: { status: 'APPROVED', name } });
    } else if (existing) {
      throw new ConflictException('That user already owns an approved agency');
    } else {
      agency = await this.prisma.agency.create({ data: { ownerId, name, status: 'APPROVED' } });
    }
    await this.audit.record({
      actorId, actorRole: actorRoles[0], action: 'agency.admin_create', targetType: 'agency', targetId: agency.id,
      metadata: { ownerId, name, levelBypassed: true },
    });
    await this.notifications.notify(ownerId, 'SYSTEM', { event: 'AGENCY_REQUEST_ACCEPTED', agencyName: agency.name });
    return agency;
  }

  async register(ownerId: string, rawName: string) {
    const name = this.cleanName(rawName);
    const [minLevel, user] = await Promise.all([
      this.getMinLevel(),
      this.prisma.user.findUnique({ where: { id: ownerId }, select: { rrydaLevel: true } }),
    ]);
    if ((user?.rrydaLevel ?? 1) < minLevel) {
      throw new ForbiddenException(`Reach level ${minLevel} to start an agency (you are level ${user?.rrydaLevel ?? 1})`);
    }
    const existing = await this.prisma.agency.findFirst({
      where: { ownerId, status: { in: ['PENDING', 'APPROVED'] } },
      select: { status: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.status === 'PENDING' ? 'You already have an agency waiting for approval' : 'You already own an agency',
      );
    }
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
    this.assertCommission(commissionBps);
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

  // ---------------------------------------------------------------------------------------------
  // Join requests (apply / invite). Accepting one is the only path that creates a membership
  // with the other party's consent; addCreator() above is the owner-only direct add.
  // ---------------------------------------------------------------------------------------------

  private async activeMembership(creatorId: string) {
    return this.prisma.agencyMembership.findFirst({ where: { creatorId, status: 'ACTIVE' }, select: { id: true } });
  }

  // Approved agencies a creator can browse and apply to.
  async directory(q?: string) {
    const term = typeof q === 'string' ? q.trim().slice(0, 60) : '';
    const rows = await this.prisma.agency.findMany({
      where: { status: 'APPROVED', ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    if (rows.length === 0) return [];
    const [owners, counts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.ownerId) } }, select: { id: true, displayName: true } }),
      this.prisma.agencyMembership.groupBy({
        by: ['agencyId'],
        where: { agencyId: { in: rows.map((r) => r.id) }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
    ]);
    const ownerName = new Map(owners.map((o) => [o.id, o.displayName]));
    const count = new Map(counts.map((c) => [c.agencyId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerName: ownerName.get(r.ownerId) ?? null,
      activeCreators: count.get(r.id) ?? 0,
    }));
  }

  async apply(agencyId: string, userId: string, message?: string) {
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency || agency.status !== 'APPROVED') throw new NotFoundException('Agency not found');
    if (agency.ownerId === userId) throw new BadRequestException('You cannot apply to your own agency');
    if (!(await this.isCreator(userId))) throw new ForbiddenException('Only approved creators can join an agency');
    if (await this.activeMembership(userId)) throw new BadRequestException('You are already in an agency');

    const pending = await this.prisma.agencyRequest.findFirst({
      where: { agencyId, creatorId: userId, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) throw new ConflictException('You already have a pending request with this agency');

    const note = typeof message === 'string' ? message.trim().slice(0, 300) : '';
    const request = await this.prisma.agencyRequest.create({
      data: { agencyId, creatorId: userId, direction: 'APPLICATION', message: note || null },
    });
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    await this.notifications.notify(agency.ownerId, 'SYSTEM', {
      event: 'AGENCY_APPLICATION',
      requestId: request.id,
      agencyName: agency.name,
      creatorId: userId,
      creatorDisplayName: me?.displayName ?? null,
    });
    return request;
  }

  async invite(agencyId: string, ownerId: string, creatorId: string, commissionBps: number) {
    this.assertCommission(commissionBps);
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Agency not found');
    if (agency.ownerId !== ownerId) throw new ForbiddenException('Only the agency owner can invite creators');
    if (agency.status !== 'APPROVED') throw new BadRequestException('Agency is not approved');
    if (typeof creatorId !== 'string' || !creatorId) throw new BadRequestException('creatorId is required');
    if (creatorId === ownerId) throw new BadRequestException('You cannot invite yourself');
    if (!(await this.isCreator(creatorId))) throw new BadRequestException('That user is not an approved creator');
    if (await this.activeMembership(creatorId)) throw new BadRequestException('Creator already has an active agency membership');

    const pending = await this.prisma.agencyRequest.findFirst({
      where: { agencyId, creatorId, status: 'PENDING' },
      select: { id: true, direction: true },
    });
    if (pending) {
      throw new ConflictException(
        pending.direction === 'APPLICATION'
          ? 'This creator already applied - accept their application instead'
          : 'You already invited this creator',
      );
    }

    const request = await this.prisma.agencyRequest.create({
      data: { agencyId, creatorId, direction: 'INVITE', commissionBps },
    });
    await this.notifications.notify(creatorId, 'SYSTEM', {
      event: 'AGENCY_INVITE',
      requestId: request.id,
      agencyName: agency.name,
      commissionBps,
    });
    return request;
  }

  // Pending requests that involve the caller, from both sides: as a creator (invites to them,
  // applications they sent) and as an agency owner (applications to them, invites they sent).
  async myRequests(userId: string) {
    const owned = await this.prisma.agency.findMany({ where: { ownerId: userId }, select: { id: true } });
    const ownedIds = owned.map((a) => a.id);
    const rows = await this.prisma.agencyRequest.findMany({
      where: {
        status: 'PENDING',
        OR: [{ creatorId: userId }, ...(ownedIds.length ? [{ agencyId: { in: ownedIds } }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (rows.length === 0) return [];
    const [agencies, users] = await Promise.all([
      this.prisma.agency.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.agencyId))] } } }),
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.creatorId))] } },
        select: { id: true, displayName: true },
      }),
    ]);
    const agencyById = new Map(agencies.map((a) => [a.id, a]));
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));

    return rows.map((r) => {
      const agency = agencyById.get(r.agencyId);
      const asOwner = agency?.ownerId === userId;
      const isInvite = r.direction === 'INVITE';
      // The receiving side answers; the sending side can withdraw.
      const receiver = isInvite ? r.creatorId === userId : asOwner;
      return {
        id: r.id,
        kind: r.direction,
        agencyId: r.agencyId,
        agencyName: agency?.name ?? null,
        creatorId: r.creatorId,
        creatorName: nameById.get(r.creatorId) ?? null,
        commissionBps: r.commissionBps,
        message: r.message,
        createdAt: r.createdAt,
        asOwner,
        canAccept: receiver,
        canDecline: receiver,
        canCancel: !receiver,
        // An application carries no commission - the owner who accepts it sets one.
        needsCommission: receiver && !isInvite,
      };
    });
  }

  async respond(
    requestId: string,
    actorId: string,
    action: 'accept' | 'decline' | 'cancel',
    commissionBps?: number,
  ) {
    const request = await this.prisma.agencyRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== 'PENDING') throw new NotFoundException('Request not found or already answered');
    const agency = await this.prisma.agency.findUnique({ where: { id: request.agencyId } });
    if (!agency) throw new NotFoundException('Agency not found');

    const isInvite = request.direction === 'INVITE';
    const actorIsCreator = request.creatorId === actorId;
    const actorIsOwner = agency.ownerId === actorId;
    const receiver = isInvite ? actorIsCreator : actorIsOwner;
    const sender = isInvite ? actorIsOwner : actorIsCreator;

    if (action === 'cancel') {
      if (!sender) throw new ForbiddenException('Only the sender can cancel this request');
    } else if (!receiver) {
      throw new ForbiddenException('Only the recipient can answer this request');
    }

    const otherPartyId = actorIsCreator ? agency.ownerId : request.creatorId;

    if (action !== 'accept') {
      const status = action === 'cancel' ? 'CANCELLED' : 'DECLINED';
      const done = await this.prisma.agencyRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: { status, respondedAt: new Date() },
      });
      if (done.count === 0) throw new ConflictException('Request was already answered');
      if (action === 'decline') {
        await this.notifications.notify(otherPartyId, 'SYSTEM', {
          event: 'AGENCY_REQUEST_DECLINED',
          agencyName: agency.name,
        });
      }
      return { status };
    }

    // accept
    if (agency.status !== 'APPROVED') throw new BadRequestException('Agency is not approved');
    const bps = this.assertCommission(isInvite ? request.commissionBps : commissionBps);
    if (await this.activeMembership(request.creatorId)) {
      throw new BadRequestException('Creator already has an active agency membership');
    }

    const membership = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.agencyRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: { status: 'ACCEPTED', respondedAt: new Date(), commissionBps: bps },
      });
      if (claimed.count === 0) throw new ConflictException('Request was already answered');
      // Joining one agency withdraws the creator's other open requests.
      await tx.agencyRequest.updateMany({
        where: { creatorId: request.creatorId, status: 'PENDING', id: { not: requestId } },
        data: { status: 'CANCELLED', respondedAt: new Date() },
      });
      return tx.agencyMembership.create({
        data: { agencyId: agency.id, creatorId: request.creatorId, commissionBps: bps },
      });
    });

    await this.notifications.notify(otherPartyId, 'SYSTEM', {
      event: 'AGENCY_REQUEST_ACCEPTED',
      agencyName: agency.name,
    });
    return { status: 'ACCEPTED', membership };
  }

  // A creator leaves their own agency (the owner already has removeCreator).
  async leave(creatorId: string) {
    const done = await this.prisma.agencyMembership.updateMany({
      where: { creatorId, status: 'ACTIVE' },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    if (done.count === 0) throw new NotFoundException('You are not in an agency');
    return { left: true };
  }

  // Commission settlement (spec §34 "receive commissions") requires reading
  // gift/creator-earnings ledger entries for each member creator over a
  // period and crediting an AGENCY_EARNINGS wallet with the agency's cut.
  // Not implemented — depends on deciding a settlement cadence (real-time
  // vs. batched daily/weekly) which is a product decision, not a technical
  // default worth guessing here.
}
