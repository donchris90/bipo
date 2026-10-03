-- Private 1-on-1 live: host rate card, renewals, pay-at-end settlement, level 3 unlock.

-- Rate card: each host's saved packages (minutes + price in coins).
CREATE TABLE "PrivateRatePackage" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "minutes" INTEGER NOT NULL,
  "priceCoins" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivateRatePackage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrivateRatePackage_hostId_minutes_key" ON "PrivateRatePackage"("hostId", "minutes");
CREATE INDEX "PrivateRatePackage_hostId_idx" ON "PrivateRatePackage"("hostId");
ALTER TABLE "PrivateRatePackage"
  ADD CONSTRAINT "PrivateRatePackage_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Requests: package link, renewal chain and the settlement record.
ALTER TABLE "PrivateLiveRequest"
  ADD COLUMN "packageId" TEXT,
  ADD COLUMN "parentRequestId" TEXT,
  ADD COLUMN "blockStartsAt" TIMESTAMP(3),
  ADD COLUMN "hostCoins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundedCoins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "settleReason" TEXT;

-- Under the old flow the host was paid when the session started. Close those sessions out so the
-- new pay-at-end settlement can never pay them a second time.
UPDATE "PrivateLiveRequest"
   SET "status" = 'COMPLETED', "settleReason" = 'LEGACY_PAID_AT_START'
 WHERE "status" = 'ACTIVE' AND "settledAt" IS NOT NULL;

-- Level unlocks: chat-call unlocks are gone. Private live unlocks at level 3.
UPDATE "HostLevel"
   SET "unlocks" = COALESCE(
         (SELECT jsonb_agg(v) FROM jsonb_array_elements("unlocks") v
           WHERE v NOT IN ('"ONE_ON_ONE_AUDIO"'::jsonb, '"ONE_ON_ONE_VIDEO"'::jsonb)),
         '[]'::jsonb)
 WHERE jsonb_typeof("unlocks") = 'array';

-- Only add it if an admin has not already put PRIVATE_LIVE on some level.
UPDATE "HostLevel"
   SET "unlocks" = (CASE WHEN jsonb_typeof("unlocks") = 'array' THEN "unlocks" ELSE '[]'::jsonb END)
                   || '["PRIVATE_LIVE"]'::jsonb
 WHERE "level" = 3
   AND NOT EXISTS (SELECT 1 FROM "HostLevel" h2 WHERE jsonb_typeof(h2."unlocks") = 'array' AND h2."unlocks" @> '["PRIVATE_LIVE"]'::jsonb);
