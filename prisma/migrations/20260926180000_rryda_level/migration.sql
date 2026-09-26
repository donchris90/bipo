-- Rryda Identity: a generic level for EVERY user, independent of the creator-only HostLevel.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RRYDA_LEVEL_UP';

ALTER TABLE "User" ADD COLUMN "rrydaXp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "rrydaLevel" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "RrydaLevel" (
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "xpRequired" INTEGER NOT NULL,
    "badgeUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RrydaLevel_pkey" PRIMARY KEY ("level")
);

-- Seed curve. Deliberately smaller thresholds than HostLevel: this XP comes from small everyday
-- amounts (a Journey mission, a check-in, following someone, sending a gift), not from minutes
-- spent broadcasting, so it needs a gentler curve to feel achievable at the same pace.
INSERT INTO "RrydaLevel" ("level","name","xpRequired","updatedAt") VALUES
(1,'New to Rryda',0,CURRENT_TIMESTAMP),
(2,'Getting Started',50,CURRENT_TIMESTAMP),
(3,'Active Member',150,CURRENT_TIMESTAMP),
(4,'Regular',300,CURRENT_TIMESTAMP),
(5,'Familiar Face',500,CURRENT_TIMESTAMP),
(6,'Social Butterfly',800,CURRENT_TIMESTAMP),
(7,'Rising Star',1200,CURRENT_TIMESTAMP),
(8,'Connector',1700,CURRENT_TIMESTAMP),
(9,'Influencer',2300,CURRENT_TIMESTAMP),
(10,'Community Pillar',3000,CURRENT_TIMESTAMP),
(11,'Icon',3800,CURRENT_TIMESTAMP),
(12,'Legend',4700,CURRENT_TIMESTAMP),
(13,'Elite',5700,CURRENT_TIMESTAMP),
(14,'Mythic',6800,CURRENT_TIMESTAMP),
(15,'Rryda Royalty',8000,CURRENT_TIMESTAMP)
ON CONFLICT ("level") DO NOTHING;
