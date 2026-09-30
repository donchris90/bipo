-- CRITICAL FIX: LudoSpectatorBet was referenced extensively by ludo.service.ts (spectatorBetStatus,
-- placeSpectatorBet, and the settlement payout logic) but never actually existed in the schema.
-- Every one of those calls has been throwing a Prisma validation error — Ludo's own spectator
-- betting has never actually worked. Fixed here, and the identical shape is reused for Ayo below.
CREATE TYPE "SpectatorBetStatus" AS ENUM ('PLACED', 'WON', 'LOST');

CREATE TABLE "LudoSpectatorBet" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerUserId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "rewardAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "SpectatorBetStatus" NOT NULL DEFAULT 'PLACED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "LudoSpectatorBet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LudoSpectatorBet_idempotencyKey_key" ON "LudoSpectatorBet"("idempotencyKey");
CREATE UNIQUE INDEX "LudoSpectatorBet_matchId_userId_key" ON "LudoSpectatorBet"("matchId", "userId");
CREATE INDEX "LudoSpectatorBet_matchId_status_idx" ON "LudoSpectatorBet"("matchId", "status");

-- Ayo: the new part. Same shape as LudoSpectatorBet above, so the same payout math
-- (calculateSpectatorPoolSplit / calculateWinningSpectatorReward) applies unchanged.
CREATE TABLE "AyoSpectatorBet" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerUserId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "rewardAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "SpectatorBetStatus" NOT NULL DEFAULT 'PLACED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "AyoSpectatorBet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AyoSpectatorBet_idempotencyKey_key" ON "AyoSpectatorBet"("idempotencyKey");
CREATE UNIQUE INDEX "AyoSpectatorBet_matchId_userId_key" ON "AyoSpectatorBet"("matchId", "userId");
CREATE INDEX "AyoSpectatorBet_matchId_status_idx" ON "AyoSpectatorBet"("matchId", "status");
