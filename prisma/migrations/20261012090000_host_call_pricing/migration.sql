-- Hosts set their own per-minute price for voice and video 1-on-1 calls (null = admin default).
ALTER TABLE "User" ADD COLUMN "videoCallPricePerMinute" INTEGER;
ALTER TABLE "User" ADD COLUMN "audioCallPricePerMinute" INTEGER;

-- The platform keeps 40% of every call (4000 bps); the host earns the other 60%.
ALTER TABLE "CallPricingConfig" ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 4000;
-- Each call remembers the fee it was started under, and what the host earned from it.
ALTER TABLE "Call" ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 4000;
ALTER TABLE "Call" ADD COLUMN "hostCoins" INTEGER NOT NULL DEFAULT 0;
