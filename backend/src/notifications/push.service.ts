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

  // Every registered device, not one user's — for platform-wide pushes (a season starting),
  // where there is no single recipient. Unlike sendToUser/announceToFollowersAndAgency (which
  // load their (small, capped) recipient set in one findMany), the whole PushToken table can be
  // arbitrarily large, so this pages through it with cursor pagination rather than loading it
  // all into memory at once. Each page is still handed to the provider as-is; provider.send
  // does its own further chunking (EXPO_MAX_BATCH) for the actual HTTP calls.
  //
  // Best-effort like sendToUser: a page that fails to send is logged and skipped, never thrown,
  // and never blocks the pages after it.
  async broadcastToAll(
    message: { title: string; body: string; data?: Record<string, unknown> },
    pageSize = 500,
  ): Promise<{ sent: number }> {
    let cursor: string | undefined;
    let sent = 0;

    for (;;) {
      let page: { id: string; token: string }[];
      try {
        page = await this.prisma.pushToken.findMany({
          take: pageSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: 'asc' },
          select: { id: true, token: true },
        });
      } catch (e: any) {
        this.logger.warn(`Broadcast push page failed to load: ${e?.message ?? e}`);
        break;
      }
      if (page.length === 0) break;

      try {
        const { invalidTokens } = await this.provider.send(page.map((t) => ({ to: t.token, ...message })));
        if (invalidTokens.length > 0) {
          await this.prisma.pushToken.deleteMany({ where: { token: { in: invalidTokens } } });
        }
        sent += page.length - invalidTokens.length;
      } catch (e: any) {
        this.logger.warn(`Broadcast push page failed to send: ${e?.message ?? e}`);
        // Still advance the cursor — a transient failure on one page shouldn't spin forever on
        // it, and the next scheduled broadcast (not a retry of this one) will reach these devices.
      }

      cursor = page[page.length - 1].id;
      if (page.length < pageSize) break;
    }

    return { sent };
  }
}
