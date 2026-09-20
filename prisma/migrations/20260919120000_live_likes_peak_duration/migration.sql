-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "peakViewerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "durationSeconds" INTEGER;
