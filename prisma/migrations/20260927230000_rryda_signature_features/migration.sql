CREATE TABLE "RrydaMoment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RrydaMoment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RrydaMoment_userId_createdAt_idx" ON "RrydaMoment"("userId", "createdAt");
CREATE INDEX "RrydaMoment_type_createdAt_idx" ON "RrydaMoment"("type", "createdAt");
ALTER TABLE "PKBattle" ADD COLUMN "objectiveConfig" JSONB;
