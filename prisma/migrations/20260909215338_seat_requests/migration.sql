-- CreateEnum
CREATE TYPE "SeatRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SeatRequest" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SeatRequestStatus" NOT NULL DEFAULT 'PENDING',
    "invitedByHost" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "SeatRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeatRequest_roomId_status_idx" ON "SeatRequest"("roomId", "status");

-- CreateIndex
CREATE INDEX "SeatRequest_userId_status_idx" ON "SeatRequest"("userId", "status");
