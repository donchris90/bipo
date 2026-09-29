-- PK timer setting: battle length in seconds. Default 180 keeps every existing battle at 3 minutes.
ALTER TABLE "PKBattle" ADD COLUMN "durationSec" INTEGER NOT NULL DEFAULT 180;
