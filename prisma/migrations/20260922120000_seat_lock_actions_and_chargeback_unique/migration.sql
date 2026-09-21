-- The seat-lock log entries use two new moderation action names.
ALTER TYPE "ModerationActionType" ADD VALUE IF NOT EXISTS 'LOCK_SEAT';
ALTER TYPE "ModerationActionType" ADD VALUE IF NOT EXISTS 'UNLOCK_SEAT';

-- A purchase can be charged back once. The schema always said so (@unique), but no
-- migration ever created the index, so the real database did not enforce it.
-- (Any duplicate rows would have to be removed first; this fails loudly if there are.)
CREATE UNIQUE INDEX IF NOT EXISTS "Chargeback_coinPurchaseId_key" ON "Chargeback"("coinPurchaseId");
