CREATE TABLE "ProfilePhoto" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfilePhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProfilePhoto_userId_sortOrder_idx" ON "ProfilePhoto"("userId", "sortOrder");

ALTER TABLE "ProfilePhoto" ADD CONSTRAINT "ProfilePhoto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
