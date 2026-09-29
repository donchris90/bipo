-- Rryda Seasons: structural core (time-boxed period, automatic participation, leaderboard,
-- admin-configured reward tiers). Event-specific missions and a dedicated event-badge catalog are
-- deliberately not part of this migration.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SEASON_REWARD';

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonParticipant" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonRewardTier" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "minRank" INTEGER NOT NULL,
    "maxRank" INTEGER NOT NULL,
    "rewardCoins" INTEGER NOT NULL,

    CONSTRAINT "SeasonRewardTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Season_startsAt_endsAt_idx" ON "Season"("startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonParticipant_seasonId_userId_key" ON "SeasonParticipant"("seasonId", "userId");

-- CreateIndex
CREATE INDEX "SeasonParticipant_seasonId_points_idx" ON "SeasonParticipant"("seasonId", "points");

-- CreateIndex
CREATE INDEX "SeasonRewardTier_seasonId_idx" ON "SeasonRewardTier"("seasonId");

-- AddForeignKey
ALTER TABLE "SeasonParticipant" ADD CONSTRAINT "SeasonParticipant_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonRewardTier" ADD CONSTRAINT "SeasonRewardTier_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
