-- AlterTable
ALTER TABLE "WithdrawalRequest" ADD COLUMN     "walletType" "WalletType" NOT NULL DEFAULT 'CREATOR_EARNINGS';

-- CreateIndex
CREATE INDEX "WithdrawalRequest_creatorId_requestedAt_idx" ON "WithdrawalRequest"("creatorId", "requestedAt");
