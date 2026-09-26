-- Admin-editable Rryda Journey chest rewards. A single row (id = 'default') replaces the
-- previously hardcoded JOURNEY_HALFWAY_REWARD_COINS / JOURNEY_ALL_REWARD_COINS constants;
-- MissionsService falls back to the same values (50 / 150) if this row is ever missing.
CREATE TABLE "JourneyConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "halfwayRewardCoins" INTEGER NOT NULL DEFAULT 50,
    "allRewardCoins" INTEGER NOT NULL DEFAULT 150,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JourneyConfig_pkey" PRIMARY KEY ("id")
);

INSERT INTO "JourneyConfig" ("id", "halfwayRewardCoins", "allRewardCoins", "updatedAt")
VALUES ('default', 50, 150, CURRENT_TIMESTAMP);
