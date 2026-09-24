CREATE TABLE "UserReport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reporterId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "description" TEXT,
  "context" TEXT,
  "contextId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "reviewerId" TEXT,
  "resolution" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "UserReport_status_createdAt_idx" ON "UserReport"("status", "createdAt");
CREATE INDEX "UserReport_targetUserId_createdAt_idx" ON "UserReport"("targetUserId", "createdAt");
CREATE INDEX "UserReport_reporterId_createdAt_idx" ON "UserReport"("reporterId", "createdAt");
