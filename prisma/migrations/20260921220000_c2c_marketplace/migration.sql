CREATE TYPE "C2COrderStatus" AS ENUM ('OPEN','ACCEPTED','PAYMENT_SUBMITTED','RELEASED','CANCELLED','DISPUTED','REFUNDED','EXPIRED');
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'C2C_ESCROW';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'C2C_RELEASE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'C2C_REFUND';
CREATE TABLE "C2COrder" (
  "id" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "coinAmount" INTEGER NOT NULL,
  "fiatAmountMinor" INTEGER NOT NULL,
  "currencyCode" TEXT NOT NULL,
  "status" "C2COrderStatus" NOT NULL DEFAULT 'OPEN',
  "paymentReference" TEXT,
  "paymentProofUrl" TEXT,
  "paymentProofNote" TEXT,
  "disputeReason" TEXT,
  "adminNote" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "disputedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "C2COrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "C2COrder_buyerId_status_idx" ON "C2COrder"("buyerId","status");
CREATE INDEX "C2COrder_sellerId_status_idx" ON "C2COrder"("sellerId","status");
CREATE INDEX "C2COrder_status_expiresAt_idx" ON "C2COrder"("status","expiresAt");
