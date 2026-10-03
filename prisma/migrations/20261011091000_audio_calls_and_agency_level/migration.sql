-- 1-on-1 voice calls: additive. Existing calls stay VIDEO.
CREATE TYPE "CallMediaType" AS ENUM ('VIDEO', 'AUDIO');
ALTER TABLE "Call" ADD COLUMN "mediaType" "CallMediaType" NOT NULL DEFAULT 'VIDEO';
ALTER TABLE "CallPricingConfig" ADD COLUMN "audioPricePerMinute" INTEGER;

-- Level a user must reach before they can create an agency themselves (admins can bypass).
CREATE TABLE "AgencyConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "minRrydaLevel" INTEGER NOT NULL DEFAULT 10,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgencyConfig_pkey" PRIMARY KEY ("id")
);
INSERT INTO "AgencyConfig" ("id", "minRrydaLevel") VALUES ('global', 10);
