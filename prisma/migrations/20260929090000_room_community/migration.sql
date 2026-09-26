-- Room Community: PartyRoom has always been one LIVE SESSION (a new row every time a host goes
-- live, gone when it closes). Nothing persisted across sessions — same title/theme/category
-- typed in fresh each time, no member history, no sense that the same regulars keep showing up.
-- Room is the thing that actually persists (one per host, for now — see the schema comment on
-- Room for why it isn't multi-room per host yet); PartyRoom.roomId links each session to it.
--
-- Level/achievement shape deliberately mirrors HostLevel/RrydaLevel/SupporterLevel/Badge — see
-- room-community.service.ts for the addXp/recordVisit logic, which mirrors
-- supporter-levels.service.ts's addXp the same way this schema mirrors its tables.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_LEVEL_UP';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_MEMBER_LEVEL_UP';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_REGULAR';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ROOM_ACHIEVEMENT';

-- AlterTable
ALTER TABLE "PartyRoom" ADD COLUMN "roomId" TEXT;
CREATE INDEX "PartyRoom_roomId_idx" ON "PartyRoom"("roomId");

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "themeColor" TEXT,
    "category" TEXT,
    "roomXp" INTEGER NOT NULL DEFAULT 0,
    "roomLevel" INTEGER NOT NULL DEFAULT 1,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "lastLiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Room_hostId_key" ON "Room"("hostId");
CREATE INDEX "Room_roomLevel_idx" ON "Room"("roomLevel");

-- CreateTable
CREATE TABLE "RoomLevel" (
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "xpRequired" INTEGER NOT NULL,
    "unlocks" JSONB,
    "badgeUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomLevel_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "RoomMember" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "visitCount" INTEGER NOT NULL DEFAULT 0,
    "visitStreak" INTEGER NOT NULL DEFAULT 0,
    "lastVisitAt" TIMESTAMP(3),
    "isRegular" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoomMember_roomId_userId_key" ON "RoomMember"("roomId", "userId");
CREATE INDEX "RoomMember_roomId_xp_idx" ON "RoomMember"("roomId", "xp");
CREATE INDEX "RoomMember_userId_idx" ON "RoomMember"("userId");

-- CreateTable
CREATE TABLE "RoomMemberLevel" (
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "xpRequired" INTEGER NOT NULL,
    "badgeUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomMemberLevel_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "RoomAchievement" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomAchievement_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RoomMemberAchievement" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "achievementKey" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomMemberAchievement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoomMemberAchievement_roomId_userId_achievementKey_key" ON "RoomMemberAchievement"("roomId", "userId", "achievementKey");
CREATE INDEX "RoomMemberAchievement_roomId_userId_idx" ON "RoomMemberAchievement"("roomId", "userId");

-- Backfill: give every host who has ever opened a PartyRoom a persistent Room, seeded from
-- their most recent session's title/theme/category, and point every one of their existing
-- sessions at it. Without this, every pre-existing host would start back at "New Room" the
-- next time RoomsService.create() runs, instead of keeping the identity they already built.
INSERT INTO "Room" ("id", "hostId", "title", "themeColor", "category", "updatedAt")
SELECT DISTINCT ON ("hostId")
    gen_random_uuid(),
    "hostId",
    "title",
    "themeColor",
    "category",
    CURRENT_TIMESTAMP
FROM "PartyRoom"
ORDER BY "hostId", "createdAt" DESC
ON CONFLICT ("hostId") DO NOTHING;

UPDATE "PartyRoom" p
SET "roomId" = r."id"
FROM "Room" r
WHERE r."hostId" = p."hostId";

-- Seed curves. xpRequired scales stand independently of HostLevel/RrydaLevel's curves — see
-- room-community.service.ts for what actually earns this XP.
INSERT INTO "RoomLevel" ("level","name","xpRequired","updatedAt") VALUES
(1,'New Room',0,CURRENT_TIMESTAMP),
(2,'Growing Room',200,CURRENT_TIMESTAMP),
(3,'Buzzing Room',600,CURRENT_TIMESTAMP),
(4,'Popular Room',1500,CURRENT_TIMESTAMP),
(5,'Thriving Room',3500,CURRENT_TIMESTAMP),
(6,'Renowned Room',7000,CURRENT_TIMESTAMP),
(7,'Elite Room',13000,CURRENT_TIMESTAMP),
(8,'Legendary Room',25000,CURRENT_TIMESTAMP)
ON CONFLICT ("level") DO NOTHING;

INSERT INTO "RoomMemberLevel" ("level","name","xpRequired","updatedAt") VALUES
(1,'Visitor',0,CURRENT_TIMESTAMP),
(2,'Familiar Face',50,CURRENT_TIMESTAMP),
(3,'Regular',150,CURRENT_TIMESTAMP),
(4,'Core Member',400,CURRENT_TIMESTAMP),
(5,'Room Veteran',1000,CURRENT_TIMESTAMP),
(6,'Room Legend',2500,CURRENT_TIMESTAMP)
ON CONFLICT ("level") DO NOTHING;

INSERT INTO "RoomAchievement" ("key","label","emoji","description","updatedAt") VALUES
('FIRST_VISIT','First Visit','👋','Visited this room for the first time',CURRENT_TIMESTAMP),
('WEEK_STREAK','Week Streak','🔥','Visited this room 7 days in a row',CURRENT_TIMESTAMP),
('BECAME_REGULAR','Became a Regular','⭐','Crossed the threshold to become a room regular',CURRENT_TIMESTAMP),
('TOP_SUPPORTER','Top Supporter','💎','Reached the top of this room''s gifting leaderboard',CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- New HostXpRule keys feeding room-community milestones into the host's existing hostXp/
-- hostLevel track (see host-levels.service.ts's awardRule) — deliberately NOT a fourth,
-- separate host progression track; a room's success is folded into the host's one.
INSERT INTO "HostXpRule" ("key","label","xpPerUnit","unit") VALUES
('ROOM_REGULAR_GAINED','Room regular gained',50,'regular'),
('ROOM_STREAK_DAY','Room live streak day',5,'day')
ON CONFLICT ("key") DO NOTHING;
