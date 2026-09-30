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
