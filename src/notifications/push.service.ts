import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, type PushProvider } from './push-provider';

// Expo tokens look like ExponentPushToken[xxxx] (or ExpoPushToken[xxxx]).
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && /^Expo(nent)?PushToken\[[^\]\s]+\]$/.test(token);
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
  ) {}

  // Keyed by token, so a device that switches accounts moves to the new
  // user instead of leaving a stale row that keeps pushing the old one's
  // notifications to it.
  async register(userId: string, token: string, platform: string | undefined) {
    if (!isExpoPushToken(token)) throw new BadRequestException('Invalid push token');
    const plat = platform === 'ios' || platform === 'android' ? platform : null;
    await this.prisma.pushToken.upsert({
      where: { token },
      update: { userId, platform: plat, lastSeenAt: new Date() },
      create: { userId, token, platform: plat },
    });
    return { registered: true };
  }

  // Scoped to the caller, so one user can't remove another's token.
  async unregister(userId: string, token: string) {
    await this.prisma.pushToken.deleteMany({ where: { userId, token } });
    return { registered: false };
  }

  // Best-effort and never throws — see NotificationsService.notify().
  async sendToUser(userId: string, message: { title: string; body: string; data?: Record<string, unknown> }) {
    try {
      const tokens = await this.prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
      if (tokens.length === 0) return;

      const { invalidTokens } = await this.provider.send(tokens.map((t) => ({ to: t.token, ...message })));
      if (invalidTokens.length > 0) {
        await this.prisma.pushToken.deleteMany({ where: { token: { in: invalidTokens } } });
      }
    } catch (e: any) {
      this.logger.warn(`Push to ${userId} failed: ${e?.message ?? e}`);
    }
  }
}
