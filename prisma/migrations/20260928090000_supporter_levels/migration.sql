-- Supporter progression: a level curve PER (supporter, creator) PAIR, distinct from RrydaLevel
-- (platform-wide identity) and HostLevel (creator-only, gates broadcasting features). This one
-- gates nothing; it exists so a fan's cumulative support for one specific creator adds up to a
-- visible, persistent rank, instead of resetting every stream the way live.service.ts's
-- per-session topGifters does.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPORTER_LEVEL_UP';

-- CreateTable
CREATE TABLE "SupporterLevel" (
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "xpRequired" INTEGER NOT NULL,
    "badgeUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupporterLevel_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "CreatorSupporter" (
    "id" TEXT NOT NULL,
    "supporterId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "totalGiftCoins" INTEGER NOT NULL DEFAULT 0,
    "giftCount" INTEGER NOT NULL DEFAULT 0,
    "firstGiftAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastGiftAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSupporter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorSupporter_supporterId_creatorId_key" ON "CreatorSupporter"("supporterId", "creatorId");

-- CreateIndex
CREATE INDEX "CreatorSupporter_creatorId_xp_idx" ON "CreatorSupporter"("creatorId", "xp");

-- CreateIndex
CREATE INDEX "CreatorSupporter_supporterId_idx" ON "CreatorSupporter"("supporterId");

-- Seed curve. xpRequired is denominated directly in lifetime coins gifted to this one creator —
-- no conversion factor, unlike RrydaLevel's gentler everyday-XP curve, because the entire point
-- of this progression is to track cumulative spend on a specific relationship.
INSERT INTO "SupporterLevel" ("level","name","xpRequired","updatedAt") VALUES
(1,'New Supporter',0,CURRENT_TIMESTAMP),
(2,'Fan',500,CURRENT_TIMESTAMP),
(3,'Bronze Supporter',2000,CURRENT_TIMESTAMP),
(4,'Silver Supporter',5000,CURRENT_TIMESTAMP),
(5,'Gold Supporter',15000,CURRENT_TIMESTAMP),
(6,'Platinum Supporter',40000,CURRENT_TIMESTAMP),
(7,'Diamond Supporter',100000,CURRENT_TIMESTAMP),
(8,'Elite Supporter',250000,CURRENT_TIMESTAMP),
(9,'Legendary Supporter',600000,CURRENT_TIMESTAMP),
(10,'Mythic Supporter',1500000,CURRENT_TIMESTAMP)
ON CONFLICT ("level") DO NOTHING;
