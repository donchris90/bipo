-- Random 1-on-1 video match (see MatchingService).
CREATE TYPE "MatchTicketStatus" AS ENUM ('WAITING', 'MATCHED');
CREATE TYPE "MatchSessionStatus" AS ENUM ('ACTIVE', 'ENDED');

CREATE TABLE "MatchTicket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "MatchTicketStatus" NOT NULL DEFAULT 'WAITING',
    "countryCode" TEXT NOT NULL,
    "sameCountryOnly" BOOLEAN NOT NULL DEFAULT false,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchTicket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchSession" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "providerChannel" TEXT NOT NULL,
    "status" "MatchSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "aLiked" BOOLEAN NOT NULL DEFAULT false,
    "bLiked" BOOLEAN NOT NULL DEFAULT false,
    "endedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "MatchSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchTicket_userId_key" ON "MatchTicket"("userId");
CREATE INDEX "MatchTicket_status_createdAt_idx" ON "MatchTicket"("status", "createdAt");
CREATE UNIQUE INDEX "MatchSession_providerChannel_key" ON "MatchSession"("providerChannel");
CREATE INDEX "MatchSession_userAId_status_idx" ON "MatchSession"("userAId", "status");
CREATE INDEX "MatchSession_userBId_status_idx" ON "MatchSession"("userBId", "status");
