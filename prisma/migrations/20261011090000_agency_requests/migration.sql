-- Agency join requests: creator applications and owner invitations. Purely additive.
CREATE TYPE "AgencyRequestKind" AS ENUM ('APPLICATION', 'INVITE');
CREATE TYPE "AgencyRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

CREATE TABLE "AgencyRequest" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "direction" "AgencyRequestKind" NOT NULL,
    "status" "AgencyRequestStatus" NOT NULL DEFAULT 'PENDING',
    "commissionBps" INTEGER,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    CONSTRAINT "AgencyRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgencyRequest_agencyId_status_idx" ON "AgencyRequest"("agencyId", "status");
CREATE INDEX "AgencyRequest_creatorId_status_idx" ON "AgencyRequest"("creatorId", "status");
