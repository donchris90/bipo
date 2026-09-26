import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WalletService } from '../economy/wallet.service';
import { HostLevelsService } from '../host-levels/host-levels.service';
import { RrydaLevelsService } from '../rryda-levels/rryda-levels.service';
import { UserStatus, RoleName, WalletType, LedgerEntryType } from '@prisma/client';
import { CHECK_IN_REWARD_SCHEDULE, computeCheckInReward, resolveCheckIn, toUtcDateKey } from './check-in-rules';

const MAX_BIO_LENGTH = 220;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly hostLevels: HostLevelsService,
    private readonly rrydaLevels: RrydaLevelsService,
  ) {}

  async findMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (!user) throw new NotFoundException();
    const { passwordHash, ...safe } = user;
    return safe;
  }

  // Real referral list — who signed up using this user's code. Only the
  // fields actually needed to show "you referred these people" (not a
  // full user dump) — deliberately not the same shape as findMe().
  async findMyReferrals(userId: string) {
    return this.prisma.user.findMany({
      where: { referredById: userId },
      select: { id: true, displayName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCheckInStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lastCheckInAt: true, checkInStreak: true },
    });
    if (!user) throw new NotFoundException();
    // resolveCheckIn reads a stale stored streak (a missed day) as 0, so the
    // status never promises a reward the next check-in wouldn't actually pay.
    const state = resolveCheckIn(user.lastCheckInAt, user.checkInStreak, new Date());
    return {
      streak: state.streak,
      alreadyCheckedInToday: state.checkedInToday,
      nextRewardCoins: Number(computeCheckInReward(state.nextStreak)),
      // Coins for streak days 1..7 (day 7 onwards pays the cap).
      rewardSchedule: CHECK_IN_REWARD_SCHEDULE,
    };
  }

  async checkIn(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lastCheckInAt: true, checkInStreak: true },
    });
    if (!user) throw new NotFoundException();

    const now = new Date();
    const state = resolveCheckIn(user.lastCheckInAt, user.checkInStreak, now);
    if (state.checkedInToday) throw new BadRequestException('Already checked in today');

    const newStreak = state.nextStreak;
    const reward = computeCheckInReward(newStreak);

    await this.prisma.user.update({
      where: { id: userId },
      data: { lastCheckInAt: now, checkInStreak: newStreak },
    });

    await this.wallet.credit({
      userId,
      walletType: WalletType.COIN,
      amount: reward,
      ledgerType: LedgerEntryType.BONUS,
      reference: 'daily-check-in',
      idempotencyKey: `check-in-${userId}-${toUtcDateKey(now)}`,
    });

    void this.rrydaLevels.addXp(userId, 10); // Rryda Identity: showing up counts, every day
    return { streak: newStreak, rewardCoins: Number(reward) };
  }

  // Self-service profile edits: displayName, avatarUrl and bio are the fields
  // a user should be able to change themselves (email/phone/countryCode are
  // identity fields, kycVerified/status/roles are admin-controlled).
  // Each field is optional and independent — a user changing just their bio
  // shouldn't have to resend an unchanged displayName. avatarUrl is trusted
  // as already-uploaded rather than a file this endpoint receives itself;
  // this only ever stores the resulting URL string. A blank bio clears it.
  async updateMe(userId: string, updates: { displayName?: string; avatarUrl?: string; bio?: string; oneOnOneEnabled?: boolean }) {
    const data: { displayName?: string; avatarUrl?: string | null; bio?: string | null; oneOnOneEnabled?: boolean } = {};

    if (updates.displayName !== undefined) {
      const trimmed = updates.displayName.trim();
      if (!trimmed || trimmed.length < 2 || trimmed.length > 40) {
        throw new BadRequestException('Display name must be between 2 and 40 characters');
      }
      data.displayName = trimmed;
    }

    if (updates.avatarUrl !== undefined) {
      const trimmed = updates.avatarUrl.trim();
      if (trimmed && !/^https?:\/\//.test(trimmed)) {
        throw new BadRequestException('avatarUrl must be a valid http(s) URL');
      }
      data.avatarUrl = trimmed || null;
    }

    if (updates.bio !== undefined) {
      if (typeof updates.bio !== 'string') throw new BadRequestException('bio must be text');
      const trimmed = updates.bio.trim();
      if (trimmed.length > MAX_BIO_LENGTH) {
        throw new BadRequestException(`Bio must be ${MAX_BIO_LENGTH} characters or fewer`);
      }
      data.bio = trimmed || null;
    }

    if (updates.oneOnOneEnabled !== undefined) {
      if (typeof updates.oneOnOneEnabled !== 'boolean') throw new BadRequestException('oneOnOneEnabled must be true or false');
      const creator = await this.prisma.userRole.findFirst({ where: { userId, role: RoleName.CREATOR } });
      if (!creator) throw new BadRequestException('Only hosts can change 1-on-1 availability');
      // Turning this ON before the host has unlocked ONE_ON_ONE_VIDEO used
      // to save silently — the switch would sit "on" in the app with no
      // indication that nobody could actually reach them, since the level
      // was only ever checked later, at call time. Enforce it here too, so
      // this endpoint can't be used to bypass the level requirement (the
      // mobile UI now also gates the switch itself — see EditProfileScreen).
      // Turning it OFF is always allowed, at any level.
      if (updates.oneOnOneEnabled) {
        await this.hostLevels.assertUnlock(userId, 'ONE_ON_ONE_VIDEO');
      }
      data.oneOnOneEnabled = updates.oneOnOneEnabled;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    const user = await this.prisma.user.update({ where: { id: userId }, data });
    const { passwordHash, ...safe } = user;
    return safe;
  }

  async setStatus(
    targetUserId: string,
    status: UserStatus,
    actorId: string,
    actorRoles: RoleName[],
  ) {
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status },
    });

    // Every sensitive admin action is audited, per spec §56/§94 non-negotiables.
    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: `user.status.${status.toLowerCase()}`,
      targetType: 'user',
      targetId: targetUserId,
    });

    const { passwordHash, ...safe } = user;
    return safe;
  }

  // No verification provider integrated — this just records the outcome of
  // a KYC check done elsewhere (manual review, a third-party service not
  // yet wired in). Never treat setting this to true as itself a
  // verification step.
  async setKycVerified(targetUserId: string, verified: boolean, actorId: string, actorRoles: RoleName[]) {
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { kycVerified: verified },
    });

    await this.audit.record({
      actorId,
      actorRole: actorRoles[0],
      action: `user.kyc.${verified ? 'verify' : 'unverify'}`,
      targetType: 'user',
      targetId: targetUserId,
    });

    const { passwordHash, ...safe } = user;
    return safe;
  }
}
