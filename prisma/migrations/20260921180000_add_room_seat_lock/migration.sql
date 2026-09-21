CREATE TABLE "RoomSeatLock" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "roomId" TEXT NOT NULL,
  "seatNumber" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomSeatLock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoomSeatLock_roomId_seatNumber_key" ON "RoomSeatLock"("roomId", "seatNumber");
CREATE INDEX "RoomSeatLock_roomId_idx" ON "RoomSeatLock"("roomId");
