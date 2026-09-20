-- CreateEnum
CREATE TYPE "RoomMode" AS ENUM ('VIDEO', 'AUDIO');

-- AlterTable
ALTER TABLE "PartyRoom" ADD COLUMN     "mode" "RoomMode" NOT NULL DEFAULT 'AUDIO';
