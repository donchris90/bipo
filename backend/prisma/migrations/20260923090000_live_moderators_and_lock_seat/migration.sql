ALTER TYPE "ModerationActionType" ADD VALUE IF NOT EXISTS 'LOCK_SEAT';
ALTER TYPE "ModerationActionType" ADD VALUE IF NOT EXISTS 'UNLOCK_SEAT';

CREATE TABLE "LiveModerator" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveModerator_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiveModerator_sessionId_userId_key" ON "LiveModerator"("sessionId", "userId");
CREATE INDEX "LiveModerator_sessionId_idx" ON "LiveModerator"("sessionId");
CREATE INDEX "LiveModerator_userId_idx" ON "LiveModerator"("userId");
ALTER TABLE "LiveModerator" ADD CONSTRAINT "LiveModerator_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveModerator" ADD CONSTRAINT "LiveModerator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
