ALTER TABLE "Gift" ADD COLUMN "luckyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Gift" ADD COLUMN "luckyType" TEXT;
ALTER TABLE "Gift" ADD COLUMN "luckyRewards" JSONB;
ALTER TABLE "GiftTransaction" ADD COLUMN "luckyRewardCoins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GiftTransaction" ADD COLUMN "luckyRewardLabel" TEXT;
ALTER TABLE "GiftTransaction" ADD COLUMN "luckyType" TEXT;
