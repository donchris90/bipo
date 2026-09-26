-- Badges: a small, deliberately short list of prestige badges (see BadgesService), earned once
-- from existing data and kept forever — never re-evaluated away if the underlying stat drops.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BADGE_EARNED';

-- CreateTable
CREATE TABLE "Badge" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeKey" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBadge_userId_idx" ON "UserBadge"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBadge_userId_badgeKey_key" ON "UserBadge"("userId", "badgeKey");

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeKey_fkey" FOREIGN KEY ("badgeKey") REFERENCES "Badge"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed catalog. Deliberately five, not fifty — see the product brief: "not 100 meaningless
-- badges... make a small number prestigious." Thresholds live in BadgesService for now (same
-- reasoning as the Journey chest rewards and Rryda Level curve — ship a concrete number now
-- rather than an admin config screen nobody asked for yet).
INSERT INTO "Badge" ("key","label","emoji","description","sortOrder","updatedAt") VALUES
('STREAK_7','7-Day Streak','🔥','Checked in 7 days in a row',1,CURRENT_TIMESTAMP),
('PERFECT_WEEK','Perfect Week','🌙','Completed every Journey mission 7 days in a row',2,CURRENT_TIMESTAMP),
('TOP_SUPPORTER','Top Supporter','👑','Sent 5,000+ coins in gifts',3,CURRENT_TIMESTAMP),
('PK_CHAMPION','PK Champion','⚡','Won 10 PK battles',4,CURRENT_TIMESTAMP),
('EARLY_RRYDA','Early Rryda','💎','One of the first 1,000 people on Rryda',5,CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
