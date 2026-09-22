import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RegionalConfigModule } from './config/regional-config.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { SocialModule } from './social/social.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MessagesModule } from './messages/messages.module';
import { CallsModule } from './calls/calls.module';
import { SearchModule } from './search/search.module';
import { FeedModule } from './feed/feed.module';
import { LiveModule } from './live/live.module';
import { RoomsModule } from './rooms/rooms.module';
import { RealtimeModule } from './realtime/realtime.module';
import { EconomyModule } from './economy/economy.module';
import { CreatorsModule } from './creators/creators.module';
import { AgenciesModule } from './agencies/agencies.module';
import { PkModule } from './pk/pk.module';
import { GamesModule } from './games/games.module';
import { QueueModule } from './queue/queue.module';
import { JobsModule } from './jobs/jobs.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { MissionsModule } from './missions/missions.module';
import { VideosModule } from './videos/videos.module';
import { UploadsModule } from './uploads/uploads.module';
import { AdminModule } from './admin/admin.module';
import { PayoutsModule } from './payouts/payouts.module';
import { KycModule } from './kyc/kyc.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { C2CModule } from './c2c/c2c.module';
import { ProfilesModule } from './profiles/profiles.module';
import { WebhookRouterModule } from './common/webhook-router.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]), // baseline rate limit; tighten per-route later (auth, gifts, entries)
    PrismaModule,
    AuditModule,
    QueueModule,
    AuthModule,
    UsersModule,
    RegionalConfigModule,
    FeatureFlagsModule,
    SocialModule,
    NotificationsModule,
    MessagesModule,
    CallsModule,
    SearchModule,
    FeedModule,
    LiveModule,
    RoomsModule,
    RealtimeModule,
    EconomyModule,
    CreatorsModule,
    AgenciesModule,
    PkModule,
    GamesModule,
    JobsModule,
    ReconciliationModule,
    MissionsModule,
    VideosModule,
    UploadsModule,
    AdminModule,
    PayoutsModule,
    KycModule,
    AnnouncementsModule,
    C2CModule,
    ProfilesModule,
    WebhookRouterModule,
  ],
})
export class AppModule {}
