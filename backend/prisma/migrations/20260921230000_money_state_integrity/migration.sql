-- Add a distinct terminal state for a provider transfer that was paid and later reversed.
ALTER TYPE "WithdrawalStatus" ADD VALUE IF NOT EXISTS 'REVERSED';

-- Strengthen provider-reference integrity for money movements.
-- PostgreSQL allows multiple NULLs in a unique index, so pending records without
-- a provider reference remain valid while an actual provider reference can
-- never be attached to two purchases/withdrawals.
CREATE UNIQUE INDEX "CoinPurchase_providerRef_key" ON "CoinPurchase"("providerRef");
CREATE UNIQUE INDEX "WithdrawalRequest_providerRef_key" ON "WithdrawalRequest"("providerRef");
