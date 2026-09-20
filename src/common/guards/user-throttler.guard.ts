import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// The stock ThrottlerGuard counts per IP. That is right for the
// unauthenticated routes (login, register), but wrong for everything behind
// login: many people share one IP (mobile carrier NAT, an office, a café), so
// one heavy user would throttle their neighbours, while a single abuser
// rotating IPs would dodge the limit entirely. Once JwtAuthGuard has run,
// count per user instead; fall back to IP when there is no user.
//
// Use it on individual routes — `@UseGuards(UserThrottlerGuard)` plus a
// `@Throttle({ default: { limit, ttl } })` — after the controller's
// JwtAuthGuard (controller-level guards run before route-level ones, so
// req.user is set by the time this runs).
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.userId ? `user:${req.user.userId}` : `ip:${req.ip}`;
  }
}
