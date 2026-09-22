ALTER TABLE "RegionalConfig"
  ADD COLUMN "creatorEarningMinorPer100Coins" INTEGER,
  ADD COLUMN "coinUsdCentsPer100" INTEGER,
  ADD COLUMN "paymentMethods" JSONB;
