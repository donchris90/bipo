-- Admin-configurable referral reward (BONUS wallet). Default preserves the previous 100-coin behaviour.
CREATE TABLE "ReferralConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "rewardCoins" INTEGER NOT NULL DEFAULT 100,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralConfig_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ReferralConfig" ("id", "rewardCoins") VALUES ('global', 100);
