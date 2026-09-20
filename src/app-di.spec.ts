import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { GAME_QUEUE, PK_QUEUE } from './queue/queue.module';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { NotificationsService } from './notifications/notifications.service';
import { MessagesService } from './messages/messages.service';
import { PkService } from './pk/pk.service';
import { RoomsService } from './rooms/rooms.service';
import { LiveService } from './live/live.service';
import { WithdrawalService } from './creators/withdrawal.service';
import { MissionsService } from './missions/missions.service';
import { VideosService } from './videos/videos.service';

// Builds the whole application's dependency graph without a database or
// Redis. This is what catches a missing import in a module, a circular
// module dependency, or a constructor that asks for something nothing
// provides — the class of mistake that type-checking and unit tests of
// individual services can't see, and that otherwise only surfaces as a
// crash on `nest start`.
describe('application dependency graph', () => {
  jest.setTimeout(30_000);

  it('resolves every provider', async () => {
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({}) // no database: onModuleInit/connect never runs at compile()
      .overrideProvider(PK_QUEUE)
      .useValue({})
      .overrideProvider(GAME_QUEUE)
      .useValue({})
      .compile();

    // Spot-check the services whose constructors changed most.
    for (const token of [
      RealtimeGateway,
      NotificationsService,
      MessagesService,
      PkService,
      RoomsService,
      LiveService,
      WithdrawalService,
      MissionsService,
      VideosService,
    ]) {
      expect(moduleRef.get(token, { strict: false })).toBeDefined();
    }

    await moduleRef.close();
  });
});
