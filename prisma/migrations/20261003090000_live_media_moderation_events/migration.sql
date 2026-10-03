CREATE TABLE "ModerationMediaEvent" (
  "id" TEXT NOT NULL,
  "context" "ChatContext" NOT NULL,
  "contextId" TEXT NOT NULL,
  "subjectUserId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "severity" INTEGER NOT NULL DEFAULT 1,
  "confidence" DOUBLE PRECISION,
  "action" TEXT NOT NULL DEFAULT 'FLAG',
  "provider" TEXT,
  "providerEventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModerationMediaEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ModerationMediaEvent_context_contextId_createdAt_idx" ON "ModerationMediaEvent"("context", "contextId", "createdAt");
CREATE INDEX "ModerationMediaEvent_subjectUserId_createdAt_idx" ON "ModerationMediaEvent"("subjectUserId", "createdAt");
CREATE INDEX "ModerationMediaEvent_category_createdAt_idx" ON "ModerationMediaEvent"("category", "createdAt");
