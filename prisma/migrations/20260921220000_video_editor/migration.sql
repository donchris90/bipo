-- CreateEnum
CREATE TYPE "VideoEditStatus" AS ENUM ('QUEUED', 'PROCESSING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "thumbnailUrl" TEXT;

-- CreateTable
CREATE TABLE "VideoEditJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "status" "VideoEditStatus" NOT NULL DEFAULT 'QUEUED',
    "sourceKey" TEXT NOT NULL,
    "overlayKey" TEXT,
    "musicKey" TEXT,
    "spec" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT,
    "tag" TEXT,
    "allowGifts" BOOLEAN NOT NULL DEFAULT true,
    "musicTitle" TEXT,
    "videoId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "VideoEditJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VideoEditJob_userId_createdAt_idx" ON "VideoEditJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoEditJob_status_idx" ON "VideoEditJob"("status");
