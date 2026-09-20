-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('PUBLISHED', 'REMOVED');

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT,
    "tag" TEXT,
    "storageKey" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationSeconds" INTEGER,
    "allowGifts" BOOLEAN NOT NULL DEFAULT true,
    "status" "VideoStatus" NOT NULL DEFAULT 'PUBLISHED',
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "countryCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoLike" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoLike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Video_storageKey_key" ON "Video"("storageKey");

-- CreateIndex
CREATE INDEX "Video_creatorId_createdAt_idx" ON "Video"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "Video_status_createdAt_idx" ON "Video"("status", "createdAt");

-- CreateIndex
CREATE INDEX "VideoLike_userId_idx" ON "VideoLike"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoLike_videoId_userId_key" ON "VideoLike"("videoId", "userId");

-- AddForeignKey
ALTER TABLE "VideoLike" ADD CONSTRAINT "VideoLike_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
