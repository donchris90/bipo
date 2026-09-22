-- CreateTable
CREATE TABLE "PayoutConfig" (
    "countryCode" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minorPer100Coins" INTEGER NOT NULL,
    "minWithdrawalCoins" INTEGER NOT NULL,
    "maxWithdrawalCoins" INTEGER,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "feeFlatMinor" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "PayoutConfig_pkey" PRIMARY KEY ("countryCode")
);

-- CreateTable
CREATE TABLE "PayoutAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "recipientCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccount_userId_key" ON "PayoutAccount"("userId");

-- AlterTable
ALTER TABLE "WithdrawalRequest" ADD COLUMN     "feeMinor" INTEGER,
ADD COLUMN     "grossMinor" INTEGER,
ADD COLUMN     "netMinor" INTEGER,
ADD COLUMN     "payoutTo" JSONB,
ADD COLUMN     "rateMinorPer100Coins" INTEGER;
