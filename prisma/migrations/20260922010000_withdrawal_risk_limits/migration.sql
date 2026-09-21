ALTER TABLE "PayoutConfig"
  ADD COLUMN "maxDailyWithdrawalCoins" INTEGER,
  ADD COLUMN "maxMonthlyWithdrawalCoins" INTEGER,
  ADD COLUMN "manualReviewAboveCoins" INTEGER,
  ADD COLUMN "cooldownHours" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "allowedProviders" JSONB;
