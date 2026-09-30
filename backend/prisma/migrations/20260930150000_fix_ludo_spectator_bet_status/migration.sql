-- Convert the original Ludo spectator-bet status column to the dedicated enum.
-- The first Ludo betting migration created this column with GameEntryStatus; the
-- Prisma schema and service use SpectatorBetStatus. This migration is safe for
-- existing installations and for fresh databases.
CREATE TYPE "SpectatorBetStatus" AS ENUM ('PLACED', 'WON', 'LOST');
ALTER TABLE "LudoSpectatorBet"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "SpectatorBetStatus" USING "status"::text::"SpectatorBetStatus",
  ALTER COLUMN "status" SET DEFAULT 'PLACED';
