-- Catch-up: brings the migration history in line with prisma/schema.prisma.
--
-- The earlier migrations stop at the Live viewer table, but the schema had
-- since gained more (avatar, referrals and check-ins on User, per-room RTC
-- channels and themes, direct messages, calls). Those were evidently applied
-- to development databases another way (e.g. `prisma db push`), so a fresh
-- database built purely from migrations was missing them, and every later
-- migration assumes they exist.
--
-- Written to be IDEMPOTENT: on a database that already has these objects it
-- does nothing; on a database built from migrations alone it creates them.

-- ── User ────────────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastCheckInAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "checkInStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "referredById" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "referralCode" TEXT;

-- Existing users get a stable code derived from their id (unique because the
-- ids are); new users get one from the application as before.
UPDATE "User" SET "referralCode" = upper(substr(replace("id", '-', ''), 1, 10)) WHERE "referralCode" IS NULL;
ALTER TABLE "User" ALTER COLUMN "referralCode" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "User_referralCode_key" ON "User"("referralCode");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_referredById_fkey') THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey"
      FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── LiveSession / PartyRoom ─────────────────────────────────────
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "themeColor" TEXT;

ALTER TABLE "PartyRoom" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "PartyRoom" ADD COLUMN IF NOT EXISTS "themeColor" TEXT;
ALTER TABLE "PartyRoom" ADD COLUMN IF NOT EXISTS "providerChannel" TEXT;
-- Rooms that predate per-room channels have no real RTC channel; give them a
-- placeholder so the column can be NOT NULL. Those rooms are old and closed
-- in practice; anyone joining one would need a fresh room anyway.
UPDATE "PartyRoom" SET "providerChannel" = 'legacy_' || "id" WHERE "providerChannel" IS NULL;
ALTER TABLE "PartyRoom" ALTER COLUMN "providerChannel" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "PartyRoom_providerChannel_key" ON "PartyRoom"("providerChannel");

-- ── Notification type: MESSAGE ──────────────────────────────────
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MESSAGE';

-- ── Direct messages ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DirectMessage" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "DirectMessage_senderId_recipientId_createdAt_idx" ON "DirectMessage"("senderId", "recipientId", "createdAt");
CREATE INDEX IF NOT EXISTS "DirectMessage_recipientId_senderId_createdAt_idx" ON "DirectMessage"("recipientId", "senderId", "createdAt");

-- ── Calls ───────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'DECLINED', 'ENDED', 'MISSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Call" (
    "id" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "calleeId" TEXT NOT NULL,
    "providerChannel" TEXT NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Call_providerChannel_key" ON "Call"("providerChannel");
CREATE INDEX IF NOT EXISTS "Call_callerId_idx" ON "Call"("callerId");
CREATE INDEX IF NOT EXISTS "Call_calleeId_idx" ON "Call"("calleeId");
