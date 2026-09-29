CREATE TABLE "LudoSpectatorBet" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerUserId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "rewardAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "GameEntryStatus" NOT NULL DEFAULT 'PLACED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "LudoSpectatorBet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LudoSpectatorBet_idempotencyKey_key" ON "LudoSpectatorBet"("idempotencyKey");
CREATE UNIQUE INDEX "LudoSpectatorBet_matchId_userId_key" ON "LudoSpectatorBet"("matchId", "userId");
CREATE INDEX "LudoSpectatorBet_matchId_idx" ON "LudoSpectatorBet"("matchId");
CREATE INDEX "LudoSpectatorBet_matchId_playerUserId_idx" ON "LudoSpectatorBet"("matchId", "playerUserId");
CREATE INDEX "LudoSpectatorBet_userId_idx" ON "LudoSpectatorBet"("userId");
