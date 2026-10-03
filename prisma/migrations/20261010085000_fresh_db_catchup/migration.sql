-- Brings databases in line with the schema where earlier migrations ran before their tables
-- existed, or where a migration was recorded as applied but its table is missing.
-- Every statement is idempotent: a no-op on a database that already has these objects.

DO $$ BEGIN
  IF to_regclass('"CreatorSupporter"') IS NOT NULL THEN
    ALTER TABLE "CreatorSupporter" ADD COLUMN IF NOT EXISTS "fanClubJoinedAt" TIMESTAMP(3);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "AyoSpectatorBet" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerUserId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "bonusAmount" INTEGER NOT NULL DEFAULT 0,
    "rewardAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "SpectatorBetStatus" NOT NULL DEFAULT 'PLACED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "AyoSpectatorBet_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AyoSpectatorBet" ADD COLUMN IF NOT EXISTS "bonusAmount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS "AyoSpectatorBet_idempotencyKey_key" ON "AyoSpectatorBet"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "AyoSpectatorBet_matchId_userId_key" ON "AyoSpectatorBet"("matchId", "userId");
CREATE INDEX IF NOT EXISTS "AyoSpectatorBet_matchId_status_idx" ON "AyoSpectatorBet"("matchId", "status");

-- The schema indexes Ludo spectator bets by (matchId, status).
CREATE INDEX IF NOT EXISTS "LudoSpectatorBet_matchId_status_idx" ON "LudoSpectatorBet"("matchId", "status");
