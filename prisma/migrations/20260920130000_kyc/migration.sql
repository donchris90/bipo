-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "PayoutConfig" ADD COLUMN     "requireKyc" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "KycSubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "fullName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "idType" TEXT NOT NULL,
    "idLast4" TEXT NOT NULL,
    "idNumberHash" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "KycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycDocument" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "KycDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycSubmission_userId_submittedAt_idx" ON "KycSubmission"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "KycSubmission_status_submittedAt_idx" ON "KycSubmission"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "KycSubmission_idNumberHash_idx" ON "KycSubmission"("idNumberHash");

-- CreateIndex
CREATE UNIQUE INDEX "KycDocument_submissionId_kind_key" ON "KycDocument"("submissionId", "kind");

-- AddForeignKey
ALTER TABLE "KycDocument" ADD CONSTRAINT "KycDocument_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "KycSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
