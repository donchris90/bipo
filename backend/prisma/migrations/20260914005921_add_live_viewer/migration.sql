-- AlterEnum
ALTER TYPE "PurchaseStatus" ADD VALUE 'CHARGEBACK';

-- AlterTable
ALTER TABLE "GameEntry" ADD COLUMN     "autoCashoutMultiplier" DOUBLE PRECISION,
ADD COLUMN     "cashedOutAt" TIMESTAMP(3),
ADD COLUMN     "cashedOutMultiplier" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "GameRound" ADD COLUMN     "hiddenState" JSONB;

-- CreateTable
CREATE TABLE "LiveViewer" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "LiveViewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chargeback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coinPurchaseId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chargeback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveViewer_sessionId_leftAt_idx" ON "LiveViewer"("sessionId", "leftAt");

-- CreateIndex
CREATE INDEX "LiveViewer_userId_idx" ON "LiveViewer"("userId");

-- CreateIndex
CREATE INDEX "Chargeback_userId_idx" ON "Chargeback"("userId");

-- CreateIndex
CREATE INDEX "LoginEvent_userId_idx" ON "LoginEvent"("userId");

-- CreateIndex
CREATE INDEX "LoginEvent_ipAddress_idx" ON "LoginEvent"("ipAddress");

-- AddForeignKey
ALTER TABLE "LiveViewer" ADD CONSTRAINT "LiveViewer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveViewer" ADD CONSTRAINT "LiveViewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
