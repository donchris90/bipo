-- Rryda Teams: structural core (identity, membership, roles, XP/level, ranking). Team missions,
-- team-specific events, and a rewards catalog are deliberately not part of this migration.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TEAM_LEVEL_UP';

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('LEADER', 'MODERATOR', 'MEMBER');

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "themeColor" TEXT,
    "category" TEXT,
    "countryCode" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "teamXp" INTEGER NOT NULL DEFAULT 0,
    "teamLevel" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "xp" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamLevel" (
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "xpRequired" INTEGER NOT NULL,
    "badgeUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamLevel_pkey" PRIMARY KEY ("level")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_leaderId_key" ON "Team"("leaderId");

-- CreateIndex
CREATE INDEX "Team_countryCode_idx" ON "Team"("countryCode");

-- CreateIndex
CREATE INDEX "Team_teamXp_idx" ON "Team"("teamXp");

-- CreateIndex: enforces "at most one team at a time" at the database level, not just in code.
CREATE UNIQUE INDEX "TeamMember_userId_key" ON "TeamMember"("userId");

-- CreateIndex
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed curve. Same reasoning as RrydaLevel/RoomLevel: a gentler curve than HostLevel since this
-- accumulates from many small, everyday contributions rather than broadcast minutes.
INSERT INTO "TeamLevel" ("level","name","xpRequired","updatedAt") VALUES
(1,'New Team',0,CURRENT_TIMESTAMP),
(2,'Forming Up',200,CURRENT_TIMESTAMP),
(3,'Active Tribe',600,CURRENT_TIMESTAMP),
(4,'Rising Team',1500,CURRENT_TIMESTAMP),
(5,'Established',3000,CURRENT_TIMESTAMP),
(6,'Regional Force',5500,CURRENT_TIMESTAMP),
(7,'Elite Team',9000,CURRENT_TIMESTAMP),
(8,'Legendary Tribe',14000,CURRENT_TIMESTAMP)
ON CONFLICT ("level") DO NOTHING;
