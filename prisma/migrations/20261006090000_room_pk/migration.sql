-- Multi-guest / Room PK. Purely additive: two new tables, nothing existing is altered.
CREATE TABLE IF NOT EXISTS "RoomPk" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "durationSec" INTEGER NOT NULL DEFAULT 180,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "winnerUserId" TEXT,
    "winnerSide" TEXT,

    CONSTRAINT "RoomPk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RoomPkParticipant" (
    "id" TEXT NOT NULL,
    "roomPkId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "side" TEXT,
    "score" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "RoomPkParticipant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RoomPk_roomId_status_idx" ON "RoomPk"("roomId", "status");
CREATE INDEX IF NOT EXISTS "RoomPk_status_endsAt_idx" ON "RoomPk"("status", "endsAt");
CREATE UNIQUE INDEX IF NOT EXISTS "RoomPkParticipant_roomPkId_userId_key" ON "RoomPkParticipant"("roomPkId", "userId");
CREATE INDEX IF NOT EXISTS "RoomPkParticipant_userId_idx" ON "RoomPkParticipant"("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RoomPkParticipant_roomPkId_fkey') THEN
    ALTER TABLE "RoomPkParticipant" ADD CONSTRAINT "RoomPkParticipant_roomPkId_fkey"
      FOREIGN KEY ("roomPkId") REFERENCES "RoomPk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
