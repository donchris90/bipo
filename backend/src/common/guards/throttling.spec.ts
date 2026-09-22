import { UserThrottlerGuard } from './user-throttler.guard';
import { AuthController } from '../../auth/auth.controller';
import { CoinPurchaseController, GiftController } from '../../economy/economy.controller';
import { CreatorsController, WithdrawalsController } from '../../creators/creators.controller';
import { GamesController } from '../../games/games.controller';
import { SocialController } from '../../social/social.controller';
import { MessagesController } from '../../messages/messages.controller';
import { CallsController } from '../../calls/calls.controller';
import { PkController } from '../../pk/pk.controller';
import { VideosController } from '../../videos/videos.controller';
import { MissionsController } from '../../missions/missions.controller';
import { NotificationsController } from '../../notifications/notifications.controller';

// @nestjs/throttler stores each route's limit/ttl as Reflect metadata under
// these keys (its constants aren't exported from the package root).
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

// The routes that can be abused (credential stuffing, spam, cost, money) and
// the per-minute limit each is expected to carry. If someone edits a
// controller and drops the decorators, this fails.
const EXPECTED: [string, any, string, number][] = [
  ['auth register', AuthController, 'register', 5],
  ['auth login', AuthController, 'login', 10],
  ['auth refresh', AuthController, 'refresh', 30],
  ['coin purchase', CoinPurchaseController, 'purchase', 10],
  ['gift send', GiftController, 'send', 120],
  ['creator apply', CreatorsController, 'apply', 5],
  ['withdrawal request', WithdrawalsController, 'request', 5],
  ['game cashout', GamesController, 'cashOut', 120],
  ['game entry', GamesController, 'placeEntry', 60],
  ['follow', SocialController, 'follow', 60],
  ['block', SocialController, 'block', 30],
  ['dm send', MessagesController, 'send', 60],
  ['call initiate', CallsController, 'initiate', 10],
  ['pk challenge', PkController, 'challenge', 20],
  ['video upload url', VideosController, 'requestUpload', 10],
  ['video publish', VideosController, 'publish', 10],
  ['mission claim', MissionsController, 'claim', 20],
  ['push token', NotificationsController, 'registerPushToken', 20],
];

describe('per-route rate limits', () => {
  it.each(EXPECTED)('%s is guarded and limited', (_label, controller, method, limit) => {
    const handler = controller.prototype[method];
    expect(Reflect.getMetadata('__guards__', handler)).toContain(UserThrottlerGuard);
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', handler)).toBe(limit);
    expect(Reflect.getMetadata(THROTTLER_TTL + 'default', handler)).toBe(60_000);
  });

  it('runs after JwtAuthGuard on authenticated controllers, so req.user is set', () => {
    // Controller-level guards are evaluated before route-level ones.
    const controllerGuards = Reflect.getMetadata('__guards__', GiftController) ?? [];
    expect(controllerGuards.length).toBeGreaterThan(0);
    expect(controllerGuards).not.toContain(UserThrottlerGuard);
  });
});

describe('UserThrottlerGuard tracker', () => {
  const tracker = (req: any) => (UserThrottlerGuard.prototype as any).getTracker.call({}, req);

  it('counts an authenticated caller by user id, not by shared IP', async () => {
    expect(await tracker({ user: { userId: 'u1' }, ip: '10.0.0.1' })).toBe('user:u1');
    expect(await tracker({ user: { userId: 'u2' }, ip: '10.0.0.1' })).toBe('user:u2');
  });

  it('falls back to the IP when there is no user (login, register)', async () => {
    expect(await tracker({ ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
  });
});
