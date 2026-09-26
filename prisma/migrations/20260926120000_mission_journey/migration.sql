-- Rryda Journey: mission metrics and a daily chest layer available to EVERY user, not only
-- creators. PostgreSQL enum values are additive, so existing MissionDefinition/MissionClaim rows
-- remain valid.
ALTER TYPE "MissionMetric" ADD VALUE IF NOT EXISTS 'MESSAGES_SENT';
ALTER TYPE "MissionMetric" ADD VALUE IF NOT EXISTS 'GIFTS_SENT';
ALTER TYPE "MissionMetric" ADD VALUE IF NOT EXISTS 'GAMES_PLAYED';
ALTER TYPE "MissionMetric" ADD VALUE IF NOT EXISTS 'LIVE_SESSIONS_WATCHED';
ALTER TYPE "MissionMetric" ADD VALUE IF NOT EXISTS 'NEW_FOLLOWS_MADE';

-- CreateTable
CREATE TABLE "MissionTierClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "rewardCoins" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionTierClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MissionTierClaim_userId_periodKey_idx" ON "MissionTierClaim"("userId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "MissionTierClaim_userId_periodKey_tier_key" ON "MissionTierClaim"("userId", "periodKey", "tier");

-- AlterTable: which audience a mission is for. The four missions that shipped before this
-- migration were all creator-hosting metrics, so they are marked creatorOnly here; anything
-- inserted after this migration defaults to everyone (false).
ALTER TABLE "MissionDefinition" ADD COLUMN "creatorOnly" BOOLEAN NOT NULL DEFAULT false;
UPDATE "MissionDefinition" SET "creatorOnly" = true
  WHERE "code" IN ('daily_live_60', 'daily_pk_win', 'daily_gifts_1000', 'daily_new_fans_100');

-- AlterTable: the Journey's own streak, parallel to checkInStreak but for a different act
-- (completing every Journey mission in a day, not just opening the app).
ALTER TABLE "User" ADD COLUMN "perfectDayStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lastPerfectDayAt" TIMESTAMP(3);
