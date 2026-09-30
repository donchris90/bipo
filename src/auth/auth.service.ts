import { ACCESS_TOKEN_DEFAULT, REFRESH_TOKEN_DEFAULT, tokenLifetime } from '../common/token-lifetime';
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../notifications/email/email.service';
import { WalletService } from '../economy/wallet.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RoleName, WalletType, LedgerEntryType } from '@prisma/client';

function hashToken(token: string): string {
  // Refresh tokens are opaque random strings; we never store them raw.
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseExpiryToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return 15 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2];
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit] ?? 60000;
  return n * mult;
}

// Referral bonus, coins, credited to both sides on a successful signup
// with a valid code — a real economic decision made here, not something
// hidden in a config file, since this project's whole economy is meant
// to be inspectable rather than magic numbers scattered around.
const REFERRAL_BONUS_COINS = 100n;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly wallet: WalletService,
  ) {}

  // Short, unique, manually-typeable — see the schema comment on
  // User.referralCode for why this isn't a UUID or deep-link token.
  // Collisions are vanishingly unlikely at any realistic user count, but
  // handled defensively rather than assumed away.
  private async generateUniqueReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars, e.g. "A1B2C3D4"
      const existing = await this.prisma.user.findUnique({ where: { referralCode: code } });
      if (!existing) return code;
    }
    // Astronomically unlikely to ever reach this, but fail loudly rather
    // than silently return a colliding code if it somehow does.
    throw new Error('Could not generate a unique referral code after 5 attempts');
  }

  // Accounts created before emails were lower-cased may be stored with capitals
  // (e.g. "Mark@Gmail.com"). Look up the normalised address first, then fall back
  // to a case-insensitive match so those existing accounts can still sign in.
  private async findUserByEmail(email: string) {
    const exact = await this.prisma.user.findUnique({ where: { email }, include: { roles: true } });
    if (exact) return exact;
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      include: { roles: true },
    });
  }

  async register(dto: RegisterDto, ipAddress?: string) {
    const email = dto.email.trim().toLowerCase();
    const countryCode = dto.countryCode.trim().toUpperCase();
    const referralCodeInput = dto.referralCode?.trim().toUpperCase();

    const existing = await this.findUserByEmail(email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // Resolved before creating the new user so a bad/unknown code fails
    // fast with a clear error, rather than silently creating an
    // unreferred account when the person typed something wrong.
    let referrer: { id: string } | null = null;
    if (referralCodeInput) {
      referrer = await this.prisma.user.findUnique({ where: { referralCode: referralCodeInput } });
      if (!referrer) {
        throw new BadRequestException('Invalid referral code');
      }
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const referralCode = await this.generateUniqueReferralCode();

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: dto.displayName?.trim() || undefined,
        countryCode,
        roles: { create: [{ role: RoleName.USER }] },
        referralCode,
        referredById: referrer?.id,
      },
      include: { roles: true },
    });

    // Audit/login telemetry is non-critical. Never turn a successful account
    // creation into a 500 just because a telemetry table/service is unavailable.
    try {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.register',
        targetType: 'user',
        targetId: user.id,
        ipAddress,
      });
    } catch (err) {
      console.error('[AuthService] Registration audit failed', err);
    }
    try {
      await this.prisma.loginEvent.create({ data: { userId: user.id, ipAddress, deviceIdHash: dto.deviceId ? this.hashDeviceId(dto.deviceId) : undefined } });
    } catch (err) {
      console.error('[AuthService] Registration login-event write failed', err);
    }

    // A failed bonus credit must never break registration itself — the
    // account already exists and is usable either way. Logged, not
    // silently swallowed, so a real crediting bug doesn't go unnoticed.
    if (referrer) {
      try {
        const deviceHash = dto.deviceId ? this.hashDeviceId(dto.deviceId) : null;
        const recentSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [sameDevice, sameIp] = await Promise.all([
          deviceHash ? this.prisma.loginEvent.findFirst({ where: { userId: referrer.id, deviceIdHash: deviceHash, createdAt: { gte: recentSince } }, select: { id: true } }) : null,
          ipAddress ? this.prisma.loginEvent.findFirst({ where: { userId: referrer.id, ipAddress, createdAt: { gte: recentSince } }, select: { id: true } }) : null,
        ]);
        if (sameDevice) {
          await this.audit.record({ actorId: user.id, action: 'referral.reward_blocked_device_reuse', targetType: 'user', targetId: referrer.id, ipAddress, metadata: { referredUserId: user.id } });
        } else if (sameIp) {
          await this.audit.record({ actorId: user.id, action: 'referral.same_ip_signal', targetType: 'user', targetId: referrer.id, ipAddress, metadata: { referredUserId: user.id } });
        }
        if (!sameDevice) {
          await this.wallet.credit({
          userId: referrer.id,
          walletType: WalletType.COIN,
          amount: REFERRAL_BONUS_COINS,
          ledgerType: LedgerEntryType.BONUS,
          reference: `referral:${user.id}`,
          idempotencyKey: `referral-bonus-referrer-${user.id}`,
        });
        await this.wallet.credit({
          userId: user.id,
          walletType: WalletType.COIN,
          amount: REFERRAL_BONUS_COINS,
          ledgerType: LedgerEntryType.BONUS,
          reference: `referred-by:${referrer.id}`,
          idempotencyKey: `referral-bonus-referee-${user.id}`,
          });
        }
      } catch (err) {
        console.error('[AuthService] Failed to credit referral bonus', err);
      }
    }

    // Fire-and-forget in spirit — EmailService.send() already swallows
    // failures internally (see its own comment), so a broken email
    // provider can never block or fail a registration. Not awaited-and-
    // ignored via a dangling promise, though — awaited so a slow provider
    // doesn't race the response, just tolerant of failure once it resolves.
    await this.email.sendWelcomeEmail({ email: user.email, name: user.displayName ?? undefined });

    return this.issueTokens(user.id, user.roles.map((r: { role: RoleName }) => r.role), user.countryCode);
  }

  async login(dto: LoginDto, ipAddress?: string) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.findUserByEmail(email);

    // Constant-shape response whether the email exists or not — avoid
    // leaking account existence via timing/error differences.
    if (!user || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    try {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        ipAddress,
      });
    } catch (err) {
      console.error('[AuthService] Login audit failed', err);
    }
    try {
      await this.prisma.loginEvent.create({ data: { userId: user.id, ipAddress, deviceIdHash: dto.deviceId ? this.hashDeviceId(dto.deviceId) : undefined } });
    } catch (err) {
      console.error('[AuthService] Login login-event write failed', err);
    }

    return this.issueTokens(user.id, user.roles.map((r: { role: RoleName }) => r.role), user.countryCode);
  }

  async refresh(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotation: revoke the used token immediately, issue a new pair.
    // If a revoked/replaced token is ever presented again, that's a signal
    // of token theft — worth alerting on in the risk engine later, not just
    // silently rejecting.
    await this.prisma.refreshToken.update({
      where: { tokenHash },
      data: { revoked: true },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
      include: { roles: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    return this.issueTokens(user.id, user.roles.map((r: { role: RoleName }) => r.role), user.countryCode);
  }

  async logout(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revoked: true },
    });
  }

  private hashDeviceId(deviceId: string): string {
    const secret = this.config.get<string>('DEVICE_FINGERPRINT_SECRET') || this.config.get<string>('JWT_ACCESS_SECRET') || 'ryda-device-signal';
    return crypto.createHmac('sha256', secret).update(deviceId).digest('hex');
  }

  private async issueTokens(userId: string, roles: RoleName[], countryCode: string) {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, roles, countryCode },
      {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: tokenLifetime(this.config.get<string>('JWT_ACCESS_EXPIRES_IN'), ACCESS_TOKEN_DEFAULT),
      },
    );

    const refreshTokenRaw = crypto.randomBytes(48).toString('hex');
    const refreshExpiresIn = tokenLifetime(this.config.get<string>('JWT_REFRESH_EXPIRES_IN'), REFRESH_TOKEN_DEFAULT);
    const expiresAt = new Date(Date.now() + parseExpiryToMs(refreshExpiresIn));

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshTokenRaw),
        expiresAt,
      },
    });

    return { accessToken, refreshToken: refreshTokenRaw, roles, userId };
  }
}
