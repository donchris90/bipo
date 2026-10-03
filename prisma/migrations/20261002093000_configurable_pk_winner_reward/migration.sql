-- Make the PK winner bonus admin-configurable while preserving the existing 500-coin default.
ALTER TABLE "PKScoreConfig" ADD COLUMN "winnerRewardCoins" INTEGER NOT NULL DEFAULT 500;
