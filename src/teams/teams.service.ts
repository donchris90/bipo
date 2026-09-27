import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { Prisma, RoleName } from '@prisma/client';

// Rryda Teams: a cross-platform tribe, distinct from Agency (a creator payout/commission
// structure — see AgencyMembership). Architecture mirrors RoomCommunityService closely, scoped to
// a team instead of a room: a small admin-configurable level curve, contributeXp() incrementing
// and recomputing level, notify-once on level-up.
//
// Deliberately the STRUCTURAL CORE ONLY — identity, membership, roles, XP/level, ranking. Team
// missions, team-specific events, and a rewards/achievement catalog are NOT part of this service;
// they would sit on top of this foundation (the way RoomAchievement sits on top of
// Room/RoomMember), so building them before this exists would mean redoing them once it does.
//
// A user belongs to at most ONE team at a time — enforced by a unique index on
// TeamMember.userId, not only in application code, so a bug here can't silently create a second
// membership.
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  static readonly MAX_NAME_LENGTH = 40;
  static readonly MAX_DESCRIPTION_LENGTH = 200;

  // ---- Shared level-curve math (same shape as RoomCommunityService.shapeProgress) -----------

  private shapeProgress(xp: number, levels: { level: number; name: string; xpRequired: number; badgeUrl?: string | null }[]) {
    const fallback = { level: 1, name: 'Level 1', xpRequired: 0, badgeUrl: null as string | null };
    const reached = levels.filter((l) => l.xpRequired <= xp);
    const current = reached[reached.length - 1] ?? levels[0] ?? fallback;
    const next = levels.find((l) => l.xpRequired > xp) ?? null;
    return {
      xp,
      level: current.level,
      name: current.name,
      badgeUrl: current.badgeUrl ?? null,
      nextLevel: next ? { level: next.level, name: next.name, xpRequired: next.xpRequired } : null,
      progressXp: next ? Math.max(0, xp - current.xpRequired) : 0,
      requiredForNext: next ? Math.max(0, next.xpRequired - current.xpRequired) : 0,
      remainingXp: next ? Math.max(0, next.xpRequired - xp) : 0,
    };
  }

  // ---- Identity + membership --------------------------------------------------------------

  private validateName(name: unknown): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new BadRequestException('Team name is required');
    if (trimmed.length > TeamsService.MAX_NAME_LENGTH) throw new BadRequestException(`Team name must be ${TeamsService.MAX_NAME_LENGTH} characters or fewer`);
    return trimmed;
  }

  async createTeam(leaderId: string, input: { name: string; description?: string; themeColor?: string | null; category?: string | null; countryCode: string }) {
    const existing = await this.prisma.teamMember.findUnique({ where: { userId: leaderId } });
    if (existing) throw new ConflictException('You already belong to a team — leave it before creating a new one');

    const name = this.validateName(input.name);
    const description = input.description?.trim().slice(0, TeamsService.MAX_DESCRIPTION_LENGTH) || null;
    if (input.themeColor && !/^#[0-9A-Fa-f]{6}$/.test(input.themeColor)) {
      throw new BadRequestException('themeColor must be a #RRGGBB hex color');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const team = await tx.team.create({
          data: { name, description, themeColor: input.themeColor ?? null, category: input.category ?? null, countryCode: input.countryCode, leaderId },
        });
        await tx.teamMember.create({ data: { teamId: team.id, userId: leaderId, role: 'LEADER' } });
        return team;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('That team name is already taken');
      }
      throw e;
    }
  }

  async joinTeam(userId: string, teamId: string) {
    const existing = await this.prisma.teamMember.findUnique({ where: { userId } });
    if (existing) throw new ConflictException('You already belong to a team — leave it before joining another');
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');

    try {
      return await this.prisma.teamMember.create({ data: { teamId, userId, role: 'MEMBER' } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('You already belong to a team — leave it before joining another');
      }
      throw e;
    }
  }

  // If the leader leaves and other members remain, the earliest-joined remaining member (after
  // the leader) is promoted automatically rather than leaving the team leaderless. If the leader
  // was the only member, the team is disbanded rather than left as an empty shell forever.
  async leaveTeam(userId: string) {
    const membership = await this.prisma.teamMember.findUnique({ where: { userId } });
    if (!membership) throw new NotFoundException('You are not on a team');

    if (membership.role !== 'LEADER') {
      await this.prisma.teamMember.delete({ where: { userId } });
      return { disbanded: false, newLeaderId: null };
    }

    return this.prisma.$transaction(async (tx) => {
      const others = await tx.teamMember.findMany({ where: { teamId: membership.teamId, userId: { not: userId } }, orderBy: { joinedAt: 'asc' } });
      if (others.length === 0) {
        await tx.teamMember.delete({ where: { userId } });
        await tx.team.delete({ where: { id: membership.teamId } });
        return { disbanded: true, newLeaderId: null };
      }
      const successor = others[0];
      await tx.teamMember.update({ where: { userId: successor.userId }, data: { role: 'LEADER' } });
      await tx.team.update({ where: { id: membership.teamId }, data: { leaderId: successor.userId } });
      await tx.teamMember.delete({ where: { userId } });
      return { disbanded: false, newLeaderId: successor.userId };
    });
  }

  async setModerator(actorId: string, targetUserId: string, isModerator: boolean) {
    const actorMembership = await this.prisma.teamMember.findUnique({ where: { userId: actorId } });
    if (!actorMembership || actorMembership.role !== 'LEADER') throw new ForbiddenException('Only the team leader can do this');
    const target = await this.prisma.teamMember.findUnique({ where: { userId: targetUserId } });
    if (!target || target.teamId !== actorMembership.teamId) throw new NotFoundException('That person is not on your team');
    if (target.role === 'LEADER') throw new BadRequestException("The leader's role can't be changed this way");
    return this.prisma.teamMember.update({ where: { userId: targetUserId }, data: { role: isModerator ? 'MODERATOR' : 'MEMBER' } });
  }

  // ---- Contribution: every member's XP feeds their team 1:1 -------------------------------

  // Called from wherever RrydaLevelsService.addXp is (missions, journey chests, check-in,
  // following someone new, sending a gift) — a team's growth is meant to feel like "everything I
  // do here helps my team", not a separate, smaller economy layered under it, which is why this
  // adds the FULL amount rather than a fraction (contrast RoomCommunityService.awardGiftXp, which
  // deliberately only forwards a fraction of a gift to the room). No-op for anyone not on a team.
  // Never throws: team contribution is a bonus signal, never a reason to fail the action that
  // earned it.
  async contributeXp(userId: string, amount: number) {
    const safe = Math.floor(Number(amount));
    if (!Number.isFinite(safe) || safe <= 0) return;
    try {
      const membership = await this.prisma.teamMember.findUnique({ where: { userId } });
      if (!membership) return;
      await this.prisma.teamMember.update({ where: { userId }, data: { xp: { increment: safe } } });
      await this.awardTeamXp(membership.teamId, safe);
    } catch {
      /* team contribution is a bonus signal, never a reason to fail the action that earned it */
    }
  }

  private async awardTeamXp(teamId: string, amount: number) {
    if (amount <= 0) return;
    const team = await this.prisma.team.update({ where: { id: teamId }, data: { teamXp: { increment: amount } } });
    const levels = await this.prisma.teamLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
    if (levels.length === 0) return;
    const level = [...levels].reverse().find((l) => l.xpRequired <= team.teamXp)?.level ?? 1;
    if (level === team.teamLevel) return;
    await this.prisma.team.update({ where: { id: teamId }, data: { teamLevel: level } });
    if (level > team.teamLevel) {
      const reached = levels.find((l) => l.level === level);
      await this.notifications.notifyOnce(team.leaderId, 'TEAM_LEVEL_UP', `team-level:${teamId}:${level}:${team.teamXp}`, {
        teamId, level, name: reached?.name ?? `Level ${level}`, xp: team.teamXp,
      });
    }
  }

  // ---- Reads --------------------------------------------------------------------------------

  private async rankOf(teamId: string, teamXp: number): Promise<number> {
    return 1 + (await this.prisma.team.count({ where: { teamXp: { gt: teamXp } } }));
  }

  async teamSnapshot(teamId: string, viewerId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) return null;

    const [levels, memberCount, viewerMembership, rank] = await Promise.all([
      this.prisma.teamLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
      this.prisma.teamMember.count({ where: { teamId } }),
      this.prisma.teamMember.findUnique({ where: { userId: viewerId } }),
      this.rankOf(team.id, team.teamXp),
    ]);

    return {
      id: team.id,
      name: team.name,
      description: team.description,
      themeColor: team.themeColor,
      category: team.category,
      countryCode: team.countryCode,
      leaderId: team.leaderId,
      memberCount,
      rank,
      team: this.shapeProgress(team.teamXp, levels),
      viewer: viewerMembership && viewerMembership.teamId === team.id
        ? { onThisTeam: true, role: viewerMembership.role, xp: viewerMembership.xp }
        : { onThisTeam: false, role: null, xp: 0 },
    };
  }

  // The caller's own team, or null if they aren't on one — the natural "my team" screen query.
  async myTeam(userId: string) {
    const membership = await this.prisma.teamMember.findUnique({ where: { userId } });
    if (!membership) return null;
    return this.teamSnapshot(membership.teamId, userId);
  }

  // Roster with the "N hosts, N supporters" breakdown from the product brief — "host"/"creator"
  // here means the CREATOR role, same distinction the rest of the app already uses.
  async tribeBoard(teamId: string, viewerId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, teamXp: true, teamLevel: true, countryCode: true } });
    if (!team) throw new NotFoundException('Team not found');
    const [top, season] = await Promise.all([
      this.prisma.team.findMany({ orderBy: { teamXp: 'desc' }, take: 5, select: { id: true, name: true, teamXp: true, teamLevel: true, countryCode: true } }),
      this.prisma.season.findFirst({ where: { startsAt: { lte: new Date() }, endsAt: { gt: new Date() } }, orderBy: { startsAt: 'desc' }, select: { id: true, name: true } }),
    ]);
    return {
      team,
      challenge: { title: 'Tribe War', description: 'Every contribution makes your tribe stronger. Rankings refresh from real team XP.', metric: 'TEAM_XP' },
      leaderboard: top.map((t, i) => ({ rank: i + 1, ...t, isMine: t.id === teamId })),
      season: season ? { id: season.id, name: season.name } : null,
      viewerId,
    };
  }

  async listRoster(teamId: string) {
    const rows = await this.prisma.teamMember.findMany({ where: { teamId }, orderBy: { xp: 'desc' } });
    if (rows.length === 0) return { members: [], creatorCount: 0, supporterCount: 0 };
    const userIds = rows.map((r) => r.userId);
    const [users, creatorRoles] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, avatarUrl: true } }),
      this.prisma.userRole.findMany({ where: { userId: { in: userIds }, role: RoleName.CREATOR }, select: { userId: true } }),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const creatorIds = new Set(creatorRoles.map((r) => r.userId));
    const members = rows.map((r) => ({
      userId: r.userId,
      displayName: byId.get(r.userId)?.displayName ?? null,
      avatarUrl: byId.get(r.userId)?.avatarUrl ?? null,
      role: r.role,
      xp: r.xp,
      isCreator: creatorIds.has(r.userId),
      joinedAt: r.joinedAt,
    }));
    return { members, creatorCount: creatorIds.size, supporterCount: rows.length - creatorIds.size };
  }

  // Global (or per-country) leaderboard — same "top N" shape as SupporterLevelsService.topSupporters
  // and RoomCommunityService.listRegulars.
  async listTopTeams(limit = 20, countryCode?: string) {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
    const rows = await this.prisma.team.findMany({
      where: countryCode ? { countryCode } : undefined,
      orderBy: { teamXp: 'desc' },
      take: safeLimit,
    });
    return rows.map((t, index) => ({
      rank: index + 1,
      id: t.id,
      name: t.name,
      themeColor: t.themeColor,
      countryCode: t.countryCode,
      teamXp: t.teamXp,
      teamLevel: t.teamLevel,
    }));
  }

  // ---- Admin: TeamLevel curve editing, same shape as RoomCommunityService.updateRoomLevel ----

  async listTeamLevels() {
    return this.prisma.teamLevel.findMany({ orderBy: { level: 'asc' } });
  }

  async updateTeamLevel(level: number, body: any, actorId: string, roles: RoleName[]) {
    if (!Number.isInteger(level) || level < 1 || level > 100) throw new BadRequestException('Level must be between 1 and 100');
    const xpRequired = Math.floor(Number(body.xpRequired));
    if (!Number.isFinite(xpRequired) || xpRequired < 0) throw new BadRequestException('xpRequired must be a non-negative number');
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 60) throw new BadRequestException('Level name is required and must be 60 characters or less');
    const updated = await this.prisma.teamLevel.upsert({
      where: { level },
      update: { name, xpRequired, badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
      create: { level, name, xpRequired, badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'team_level.update', targetType: 'team_level', targetId: String(level), metadata: { xpRequired, name } });
    return updated;
  }
}
