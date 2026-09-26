import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { HostLevelsService } from '../host-levels/host-levels.service';
import { RoleName } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { resolveCheckIn, toUtcDateKey } from '../users/check-in-rules';

// Room Community: everything that makes a Party Room a persistent COMMUNITY instead of
// just a live session. Architecture mirrors the rest of the *-levels services on purpose
// (see supporter-levels.service.ts, whose addXp/progress shape this borrows almost exactly) —
// a small admin-configurable level curve, an addXp() that increments and recomputes level,
// and a notify-once on level-up. The two structural differences from SupporterLevelsService:
//   1. There are TWO curves here, not one — RoomLevel (the room's own level, one row per host,
//      like HostLevel) and RoomMemberLevel (a visitor's standing in whichever room they're in,
//      global like SupporterLevel).
//   2. Visits are on a daily cadence (see recordVisit), not a per-gift one — a room community
//      is built by people showing up, not just by people paying, so gifts (awardXp) are only
//      one of two ways this grows.
@Injectable()
export class RoomCommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly hostLevels: HostLevelsService,
  ) {}

  // Flat per-unique-day rewards. Disclosed constants, not hidden numbers — same spirit as
  // check-in-rules.ts's CHECK_IN_COINS_PER_DAY.
  static readonly DAILY_VISIT_MEMBER_XP = 10;
  static readonly DAILY_VISIT_ROOM_XP = 5;
  // A gift's room-XP contribution is a fraction of its member-XP contribution (which is the
  // full coin amount, same denomination as SupporterLevelsService) — the room level should
  // climb slower than any one member's own standing in it.
  static readonly GIFT_ROOM_XP_DIVISOR = 10;
  static readonly WEEK_STREAK_DAYS = 7;
  // A "regular" is someone who has shown up on enough distinct days to be a fixture, not just
  // someone who gifted once. Visits, not spend, gate this — spend has its own recognition via
  // TOP_SUPPORTER and the member's own xp/level.
  static readonly REGULAR_MIN_VISITS = 5;

  // ---- Room identity -------------------------------------------------

  // Called from RoomsService.create(). One persistent Room per host: the first time they ever
  // start a Party Room this creates it (seeded from what they typed for THIS session); every
  // session after that reuses it and — deliberately — does NOT overwrite title/theme/category
  // from the session input, so a host can't accidentally blank out their room identity by
  // leaving a field empty when starting a quick session. setIdentity() below is the explicit
  // path for actually changing it.
  async getOrCreateRoomForHost(hostId: string, defaults: { title: string; themeColor?: string | null; category?: string | null }) {
    const existing = await this.prisma.room.findUnique({ where: { hostId } });
    if (existing) return existing;
    return this.prisma.room.create({
      data: {
        hostId,
        title: defaults.title,
        themeColor: defaults.themeColor ?? null,
        category: defaults.category ?? null,
      },
    });
  }

  // Explicit host edit to the persistent identity — distinct from RoomsService.setTheme, which
  // only ever touched the live PartyRoom session's themeColor. This updates the identity that
  // outlives the session; the running session's own display fields are left for the host's
  // existing per-session controls to manage.
  async setIdentity(hostId: string, updates: { title?: string; description?: string | null; themeColor?: string | null; category?: string | null }) {
    const data: Record<string, unknown> = {};
    if (updates.title !== undefined) {
      const title = updates.title.trim();
      if (!title) throw new BadRequestException('Room title cannot be empty');
      data.title = title;
    }
    if (updates.description !== undefined) data.description = updates.description?.trim() || null;
    if (updates.themeColor !== undefined) {
      if (updates.themeColor && !/^#[0-9A-Fa-f]{6}$/.test(updates.themeColor)) {
        throw new BadRequestException('themeColor must be a #RRGGBB hex color');
      }
      data.themeColor = updates.themeColor;
    }
    if (updates.category !== undefined) data.category = updates.category;
    return this.prisma.room.update({ where: { hostId }, data });
  }

  // ---- Shared level-curve math (same shape as SupporterLevelsService.shapeProgress) --------

  private shapeProgress(xp: number, levels: { level: number; name: string; xpRequired: number; badgeUrl?: string | null; unlocks?: unknown }[]) {
    const fallback = levels[0] ?? { level: 1, name: 'Level 1', xpRequired: 0, badgeUrl: null, unlocks: null };
    const reached = levels.filter((l) => l.xpRequired <= xp);
    const current = reached[reached.length - 1] ?? fallback;
    const next = levels.find((l) => l.xpRequired > xp) ?? null;
    return {
      xp,
      level: current.level,
      name: current.name,
      badgeUrl: current.badgeUrl ?? null,
      unlocks: (current as { unlocks?: unknown }).unlocks ?? null,
      nextLevel: next ? { level: next.level, name: next.name, xpRequired: next.xpRequired } : null,
      progressXp: next ? Math.max(0, xp - current.xpRequired) : 0,
      requiredForNext: next ? Math.max(0, next.xpRequired - current.xpRequired) : 0,
      remainingXp: next ? Math.max(0, next.xpRequired - xp) : 0,
    };
  }

  // ---- Visits: what turns a session into a community ------------------

  // Called from RoomsService.joinToken(), best-effort, every time someone (host included)
  // actually enters the room screen — same call site LiveService's own visit tracking would use.
  // Awards at most once per UTC calendar day per (room, user), same day-boundary rule as
  // User.checkInStreak, reusing the exact same pure resolveCheckIn() rather than re-deriving it.
  // Never throws: a community signal is a bonus, never a reason to block someone entering a room.
  async recordVisit(roomId: string | null, userId: string) {
    if (!roomId) return; // pre-migration session with no linked Room yet
    try {
      const now = new Date();
      const existing = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
      const state = resolveCheckIn(existing?.lastVisitAt ?? null, existing?.visitStreak ?? 0, now);
      if (state.checkedInToday) return; // already credited today

      const wasRegular = existing?.isRegular ?? false;
      const visitCount = (existing?.visitCount ?? 0) + 1;
      const isRegular = wasRegular || visitCount >= RoomCommunityService.REGULAR_MIN_VISITS;

      const member = await this.prisma.roomMember.upsert({
        where: { roomId_userId: { roomId, userId } },
        update: {
          xp: { increment: RoomCommunityService.DAILY_VISIT_MEMBER_XP },
          visitCount,
          visitStreak: state.nextStreak,
          lastVisitAt: now,
          isRegular,
        },
        create: {
          roomId,
          userId,
          xp: RoomCommunityService.DAILY_VISIT_MEMBER_XP,
          visitCount: 1,
          visitStreak: 1,
          lastVisitAt: now,
          isRegular: false,
        },
      });

      await this.recomputeMemberLevel(member.id, member.xp, member.level, roomId, userId);
      await this.awardRoomXp(roomId, RoomCommunityService.DAILY_VISIT_ROOM_XP);

      if (visitCount === 1) {
        await this.grantAchievement(roomId, userId, 'FIRST_VISIT');
      }
      if (state.nextStreak > 0 && state.nextStreak % RoomCommunityService.WEEK_STREAK_DAYS === 0) {
        await this.grantAchievement(roomId, userId, 'WEEK_STREAK');
      }
      if (!wasRegular && isRegular) {
        await this.grantAchievement(roomId, userId, 'BECAME_REGULAR');
        await this.notifications.notifyOnce(userId, 'ROOM_REGULAR', `room-regular:${roomId}:${userId}`, { roomId });
        const room = await this.prisma.room.findUnique({ where: { id: roomId }, select: { hostId: true } });
        if (room) {
          try {
            await this.hostLevels.awardRule(room.hostId, 'ROOM_REGULAR_GAINED', 1);
          } catch {
            /* host progression is a bonus signal off this event, never a reason to fail it */
          }
        }
      }
    } catch {
      /* recordVisit is a bonus signal fired from the join-token hot path — never block entry */
    }
  }

  // Called from GiftService.send() when a gift is sent with context ROOM, mirroring
  // SupporterLevelsService.addXp exactly — full coin amount as member XP, plus a smaller
  // fraction feeding the room's own level. contextId there is the live PartyRoom's id, so this
  // resolves it to the persistent Room first.
  async awardGiftXp(partyRoomId: string, userId: string, coinAmount: number) {
    const safe = Math.floor(Number(coinAmount));
    if (!Number.isFinite(safe) || safe <= 0) return;
    try {
      const session = await this.prisma.partyRoom.findUnique({ where: { id: partyRoomId }, select: { roomId: true } });
      if (!session?.roomId) return;
      const roomId = session.roomId;

      const member = await this.prisma.roomMember.upsert({
        where: { roomId_userId: { roomId, userId } },
        update: { xp: { increment: safe } },
        create: { roomId, userId, xp: safe },
      });
      await this.recomputeMemberLevel(member.id, member.xp, member.level, roomId, userId);
      await this.awardRoomXp(roomId, Math.floor(safe / RoomCommunityService.GIFT_ROOM_XP_DIVISOR));
      await this.maybeAwardTopSupporter(roomId, userId);
    } catch {
      /* progression must never fail a paid gift */
    }
  }

  private async recomputeMemberLevel(memberId: string, xp: number, storedLevel: number, roomId: string, userId: string) {
    const levels = await this.prisma.roomMemberLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
    if (levels.length === 0) return;
    const level = [...levels].reverse().find((l) => l.xpRequired <= xp)?.level ?? 1;
    if (level === storedLevel) return;
    await this.prisma.roomMember.update({ where: { id: memberId }, data: { level } });
    if (level > storedLevel) {
      const reached = levels.find((l) => l.level === level);
      await this.notifications.notifyOnce(userId, 'ROOM_MEMBER_LEVEL_UP', `room-member-level:${roomId}:${level}:${xp}`, {
        roomId, level, name: reached?.name ?? `Level ${level}`, xp,
      });
    }
  }

  private async awardRoomXp(roomId: string, amount: number) {
    if (amount <= 0) return;
    const room = await this.prisma.room.update({ where: { id: roomId }, data: { roomXp: { increment: amount } } });
    const levels = await this.prisma.roomLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
    if (levels.length === 0) return;
    const level = [...levels].reverse().find((l) => l.xpRequired <= room.roomXp)?.level ?? 1;
    if (level === room.roomLevel) return;
    await this.prisma.room.update({ where: { id: roomId }, data: { roomLevel: level } });
    if (level > room.roomLevel) {
      const reached = levels.find((l) => l.level === level);
      await this.notifications.notifyOnce(room.hostId, 'ROOM_LEVEL_UP', `room-level:${roomId}:${level}:${room.roomXp}`, {
        roomId, level, name: reached?.name ?? `Level ${level}`, xp: room.roomXp,
      });
    }
  }

  private async maybeAwardTopSupporter(roomId: string, userId: string) {
    const top = await this.prisma.roomMember.findFirst({ where: { roomId }, orderBy: { xp: 'desc' } });
    if (top?.userId === userId) await this.grantAchievement(roomId, userId, 'TOP_SUPPORTER');
  }

  private async grantAchievement(roomId: string, userId: string, key: string) {
    const achievement = await this.prisma.roomAchievement.findUnique({ where: { key } });
    if (!achievement || !achievement.active) return;
    try {
      await this.prisma.roomMemberAchievement.create({ data: { roomId, userId, achievementKey: key } });
    } catch {
      return; // already earned (unique constraint) — earned once, kept forever, like Badge
    }
    await this.notifications.notifyOnce(userId, 'ROOM_ACHIEVEMENT', `room-achievement:${roomId}:${userId}:${key}`, {
      roomId, key, label: achievement.label, emoji: achievement.emoji,
    });
  }

  // ---- Host session streak --------------------------------------------

  // Called from RoomsService.finishClose(). A room's streak is "consecutive UTC days with at
  // least one closed session" — reuses resolveCheckIn again rather than re-deriving day math a
  // third time in this one feature.
  async recordHostSession(roomId: string | null) {
    if (!roomId) return;
    try {
      const room = await this.prisma.room.findUnique({ where: { id: roomId } });
      if (!room) return;
      const now = new Date();
      const state = resolveCheckIn(room.lastLiveAt, room.streak, now);
      if (state.checkedInToday) return; // already counted a session today
      await this.prisma.room.update({ where: { id: roomId }, data: { streak: state.nextStreak, lastLiveAt: now } });
      try {
        await this.hostLevels.awardRule(room.hostId, 'ROOM_STREAK_DAY', 1);
      } catch {
        /* host progression is a bonus signal, never a reason to fail room close */
      }
    } catch {
      /* streak bookkeeping is a bonus signal, never a reason to fail a room close */
    }
  }

  // Lightweight version of communitySnapshot's room-progress half, with the streak folded in —
  // meant to be embedded directly into another payload (RoomsController.getRoomDetails) rather
  // than fetched as its own round trip. Deliberately excludes viewer-specific fields, member/
  // regular counts and the regulars list, which stay behind the full communitySnapshot/
  // listRegulars endpoints for the Community tab.
  async roomLevelSummary(roomId: string | null) {
    if (!roomId) return null;
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return null;
    const roomLevels = await this.prisma.roomLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } });
    return { streak: room.streak, ...this.shapeProgress(room.roomXp, roomLevels) };
  }

  // ---- Reads -----------------------------------------------------------

  // Full snapshot for a room's "Community" tab: identity, room-level progress, streak, and the
  // viewer's own membership if they have one — same zero-state pattern as
  // SupporterLevelsService.progress (a viewer who's never visited gets Visitor/0, not a 404).
  async communitySnapshot(hostId: string, viewerId: string) {
    const room = await this.prisma.room.findUnique({ where: { hostId } });
    if (!room) return null;

    const [roomLevels, memberLevels, viewerMember, memberCount, regularCount] = await Promise.all([
      this.prisma.roomLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
      this.prisma.roomMemberLevel.findMany({ where: { active: true }, orderBy: { level: 'asc' } }),
      this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId: room.id, userId: viewerId } } }),
      this.prisma.roomMember.count({ where: { roomId: room.id } }),
      this.prisma.roomMember.count({ where: { roomId: room.id, isRegular: true } }),
    ]);

    return {
      roomId: room.id,
      hostId: room.hostId,
      title: room.title,
      description: room.description,
      themeColor: room.themeColor,
      category: room.category,
      streak: room.streak,
      memberCount,
      regularCount,
      room: this.shapeProgress(room.roomXp, roomLevels),
      viewer: {
        ...this.shapeProgress(viewerMember?.xp ?? 0, memberLevels),
        visitCount: viewerMember?.visitCount ?? 0,
        visitStreak: viewerMember?.visitStreak ?? 0,
        isRegular: viewerMember?.isRegular ?? false,
      },
    };
  }

  // Regulars/leaderboard for the room's community tab — same "top N by xp" shape as
  // SupporterLevelsService.topSupporters.
  async listRegulars(hostId: string, limit = 20) {
    const room = await this.prisma.room.findUnique({ where: { hostId }, select: { id: true } });
    if (!room) return [];
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20));
    const rows = await this.prisma.roomMember.findMany({
      where: { roomId: room.id, isRegular: true },
      orderBy: { xp: 'desc' },
      take: safeLimit,
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r, index) => ({
      rank: index + 1,
      userId: r.userId,
      displayName: byId.get(r.userId)?.displayName ?? null,
      avatarUrl: byId.get(r.userId)?.avatarUrl ?? null,
      xp: r.xp,
      level: r.level,
      visitCount: r.visitCount,
      visitStreak: r.visitStreak,
    }));
  }

  async listAchievements(roomId: string, userId: string) {
    return this.prisma.roomMemberAchievement.findMany({ where: { roomId, userId }, orderBy: { earnedAt: 'asc' } });
  }

  // ---- Admin: level-curve editing, same shape as SupporterLevelsService.updateLevel --------

  async listRoomLevels() {
    return this.prisma.roomLevel.findMany({ orderBy: { level: 'asc' } });
  }

  async updateRoomLevel(level: number, body: any, actorId: string, roles: RoleName[]) {
    if (!Number.isInteger(level) || level < 1 || level > 100) throw new BadRequestException('Level must be between 1 and 100');
    const xpRequired = Math.floor(Number(body.xpRequired));
    if (!Number.isFinite(xpRequired) || xpRequired < 0) throw new BadRequestException('xpRequired must be a non-negative number');
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 60) throw new BadRequestException('Level name is required and must be 60 characters or less');
    const updated = await this.prisma.roomLevel.upsert({
      where: { level },
      update: { name, xpRequired, unlocks: body.unlocks ?? null, badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
      create: { level, name, xpRequired, unlocks: body.unlocks ?? null, badgeUrl: body.badgeUrl ? String(body.badgeUrl) : null, active: body.active !== false },
    });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'room_level.update', targetType: 'room_level', targetId: String(level), metadata: { xpRequired, name } });
    return updated;
  }
}
