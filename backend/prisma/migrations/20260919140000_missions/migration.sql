-- CreateEnum
CREATE TYPE "MissionMetric" AS ENUM ('LIVE_MINUTES', 'PK_WINS', 'GIFT_COINS_RECEIVED', 'NEW_FOLLOWERS');

-- CreateTable
CREATE TABLE "MissionDefinition" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metric" "MissionMetric" NOT NULL,
    "target" INTEGER NOT NULL,
    "rewardCoins" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "rewardCoins" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MissionDefinition_code_key" ON "MissionDefinition"("code");

-- CreateIndex
CREATE INDEX "MissionClaim_userId_periodKey_idx" ON "MissionClaim"("userId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "MissionClaim_userId_missionId_periodKey_key" ON "MissionClaim"("userId", "missionId", "periodKey");

-- AddForeignKey
ALTER TABLE "MissionClaim" ADD CONSTRAINT "MissionClaim_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "MissionDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Starter missions (the four shown in the Creator Center). Targets and
-- rewards are PLACEHOLDERS to tune — edit these rows (or add new ones) in
-- the database; nothing in code depends on the specific values.
INSERT INTO "MissionDefinition" ("id", "code", "title", "description", "metric", "target", "rewardCoins", "sortOrder") VALUES
  ('00000000-0000-4000-8000-000000000001', 'daily_live_60',      'Daily live broadcast',  'Broadcast for 60 minutes today',      'LIVE_MINUTES',        60,   180, 1),
  ('00000000-0000-4000-8000-000000000002', 'daily_pk_win',       'PK battle win',         'Win 1 PK battle today',               'PK_WINS',             1,    300, 2),
  ('00000000-0000-4000-8000-000000000003', 'daily_gifts_1000',   'Fan gifting milestone', 'Receive 1,000 coins in gifts today',  'GIFT_COINS_RECEIVED', 1000, 500, 3),
  ('00000000-0000-4000-8000-000000000004', 'daily_new_fans_100', 'New fan acquisition',   'Gain 100 new followers today',        'NEW_FOLLOWERS',       100,  200, 4);
