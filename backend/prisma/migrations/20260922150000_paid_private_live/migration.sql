-- Paid private 1-on-1 live sessions.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'PRIVATE_LIVE_PAYMENT';
-- Paid private 1-on-1 live sessions.
CREATE TYPE "PrivateLiveRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'ACTIVE', 'COMPLETED', 'REFUNDED');

ALTER TABLE "LiveSession"
  ADD COLUMN "privatePriceCoins" INTEGER,
  ADD COLUMN "privateDurationSeconds" INTEGER,
  ADD COLUMN "privateStartedAt" TIMESTAMP(3),
  ADD COLUMN "privateEndsAt" TIMESTAMP(3);

CREATE TABLE "PrivateLiveRequest" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "status" "PrivateLiveRequestStatus" NOT NULL DEFAULT 'PENDING',
  "priceCoins" INTEGER NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),

  CONSTRAINT "PrivateLiveRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrivateLiveRequest_sessionId_status_idx" ON "PrivateLiveRequest"("sessionId", "status");
CREATE INDEX "PrivateLiveRequest_viewerId_status_idx" ON "PrivateLiveRequest"("viewerId", "status");
CREATE INDEX "PrivateLiveRequest_sessionId_viewerId_idx" ON "PrivateLiveRequest"("sessionId", "viewerId");

ALTER TABLE "PrivateLiveRequest"
  ADD CONSTRAINT "PrivateLiveRequest_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrivateLiveRequest"
  ADD CONSTRAINT "PrivateLiveRequest_viewerId_fkey"
  FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
