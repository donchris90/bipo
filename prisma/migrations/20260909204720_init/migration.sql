-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('GUEST', 'USER', 'CREATOR', 'MODERATOR', 'AGENCY', 'FINANCE_ADMIN', 'TRUST_SAFETY_ADMIN', 'GAME_OPERATOR', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_REVIEW');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('FOLLOW', 'SYSTEM', 'SECURITY');

-- CreateEnum
CREATE TYPE "LiveStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "RoomPrivacy" AS ENUM ('PUBLIC', 'PRIVATE', 'FOLLOWERS_ONLY', 'INVITE_ONLY');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ChatContext" AS ENUM ('ROOM', 'LIVE');

-- CreateEnum
CREATE TYPE "ModerationActionType" AS ENUM ('MUTE', 'UNMUTE', 'BAN', 'UNBAN', 'KICK', 'ADD_MODERATOR', 'REMOVE_MODERATOR', 'LOCK_ROOM', 'UNLOCK_ROOM');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('COIN', 'CREATOR_EARNINGS', 'AGENCY_EARNINGS', 'BONUS');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('COIN_PURCHASE', 'GIFT_SENT', 'GIFT_RECEIVED', 'GAME_ENTRY', 'GAME_REWARD', 'WITHDRAWAL', 'WITHDRAWAL_RELEASE', 'REFUND', 'CHARGEBACK', 'BONUS', 'ADJUSTMENT', 'AGENCY_COMMISSION', 'PK_SCORE');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CreatorApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AgencyStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "PKStatus" AS ENUM ('CHALLENGED', 'ACCEPTED', 'COUNTDOWN', 'ACTIVE', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('ACTIVE', 'DISABLED', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "RoundStatus" AS ENUM ('SCHEDULED', 'OPEN', 'LOCKED', 'RESOLVING', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GameEntryStatus" AS ENUM ('PLACED', 'WON', 'LOST', 'REFUNDED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "countryCode" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "kycVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RoleName" NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "replacedBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionalConfig" (
    "countryCode" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "defaultLanguage" TEXT NOT NULL,
    "minAge" INTEGER NOT NULL DEFAULT 18,
    "gamesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "paymentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegionalConfig_pkey" PRIMARY KEY ("countryCode")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mute" (
    "id" TEXT NOT NULL,
    "muterId" TEXT NOT NULL,
    "mutedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "payload" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "RoleName",
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveSession" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "providerChannel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "coverUrl" TEXT,
    "privacy" "RoomPrivacy" NOT NULL DEFAULT 'PUBLIC',
    "countryCode" TEXT NOT NULL,
    "status" "LiveStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyRoom" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "privacy" "RoomPrivacy" NOT NULL DEFAULT 'PUBLIC',
    "seatCount" INTEGER NOT NULL DEFAULT 8,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "status" "RoomStatus" NOT NULL DEFAULT 'OPEN',
    "countryCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PartyRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomSeat" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomModerator" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomModerator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "context" "ChatContext" NOT NULL,
    "contextId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actionType" "ModerationActionType" NOT NULL,
    "targetUserId" TEXT,
    "context" "ChatContext" NOT NULL,
    "contextId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "WalletType" NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT,
    "type" "LedgerEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT,
    "reference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinPackage" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "CoinPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gift" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coinPrice" INTEGER NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Gift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftTransaction" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "giftId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "context" "ChatContext",
    "contextId" TEXT,
    "pkBattleId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueSplitConfig" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT,
    "creatorShareBps" INTEGER NOT NULL,
    "platformShareBps" INTEGER NOT NULL,
    "agencyShareBps" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueSplitConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CreatorApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "CreatorApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "riskFlags" JSONB,
    "payoutProvider" TEXT,
    "providerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agency" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" "AgencyStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyMembership" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "commissionBps" INTEGER NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgencyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PKBattle" (
    "id" TEXT NOT NULL,
    "challengerId" TEXT NOT NULL,
    "opponentId" TEXT NOT NULL,
    "status" "PKStatus" NOT NULL DEFAULT 'CHALLENGED',
    "scoreChallenger" BIGINT NOT NULL DEFAULT 0,
    "scoreOpponent" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "PKBattle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PKScoreConfig" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT,
    "coinsPerPoint" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PKScoreConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameDefinition" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "GameStatus" NOT NULL DEFAULT 'DISABLED',
    "minAge" INTEGER NOT NULL DEFAULT 18,
    "rulesJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameDefinition_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "GameRegionConfig" (
    "id" TEXT NOT NULL,
    "gameCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GameRegionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameRound" (
    "id" TEXT NOT NULL,
    "gameCode" TEXT NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "numberRange" INTEGER,
    "selectionCount" INTEGER,
    "entryPrice" INTEGER NOT NULL,
    "openAt" TIMESTAMP(3) NOT NULL,
    "lockAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    "commitmentHash" TEXT,
    "revealData" TEXT,
    "status" "RoundStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "GameRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameEntry" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "selection" JSONB NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "rewardAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "GameEntryStatus" NOT NULL DEFAULT 'PLACED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_countryCode_idx" ON "User"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_role_key" ON "UserRole"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Follow_followingId_idx" ON "Follow"("followingId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "Block_blockerId_blockedId_key" ON "Block"("blockerId", "blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "Mute_muterId_mutedId_key" ON "Mute"("muterId", "mutedId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LiveSession_providerChannel_key" ON "LiveSession"("providerChannel");

-- CreateIndex
CREATE INDEX "LiveSession_hostId_idx" ON "LiveSession"("hostId");

-- CreateIndex
CREATE INDEX "LiveSession_status_idx" ON "LiveSession"("status");

-- CreateIndex
CREATE INDEX "PartyRoom_hostId_idx" ON "PartyRoom"("hostId");

-- CreateIndex
CREATE INDEX "PartyRoom_status_idx" ON "PartyRoom"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RoomSeat_roomId_seatNumber_key" ON "RoomSeat"("roomId", "seatNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RoomSeat_roomId_userId_key" ON "RoomSeat"("roomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomModerator_roomId_userId_key" ON "RoomModerator"("roomId", "userId");

-- CreateIndex
CREATE INDEX "ChatMessage_context_contextId_createdAt_idx" ON "ChatMessage"("context", "contextId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationAction_context_contextId_idx" ON "ModerationAction"("context", "contextId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_type_key" ON "Wallet"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_idx" ON "LedgerEntry"("walletId");

-- CreateIndex
CREATE INDEX "LedgerEntry_type_idx" ON "LedgerEntry"("type");

-- CreateIndex
CREATE INDEX "CoinPackage_countryCode_active_idx" ON "CoinPackage"("countryCode", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CoinPurchase_idempotencyKey_key" ON "CoinPurchase"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CoinPurchase_userId_idx" ON "CoinPurchase"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Gift_code_key" ON "Gift"("code");

-- CreateIndex
CREATE UNIQUE INDEX "GiftTransaction_idempotencyKey_key" ON "GiftTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GiftTransaction_recipientId_idx" ON "GiftTransaction"("recipientId");

-- CreateIndex
CREATE INDEX "GiftTransaction_pkBattleId_idx" ON "GiftTransaction"("pkBattleId");

-- CreateIndex
CREATE INDEX "RevenueSplitConfig_scope_scopeKey_active_idx" ON "RevenueSplitConfig"("scope", "scopeKey", "active");

-- CreateIndex
CREATE INDEX "CreatorApplication_userId_idx" ON "CreatorApplication"("userId");

-- CreateIndex
CREATE INDEX "CreatorApplication_status_idx" ON "CreatorApplication"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_idempotencyKey_key" ON "WithdrawalRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_creatorId_idx" ON "WithdrawalRequest"("creatorId");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_idx" ON "WithdrawalRequest"("status");

-- CreateIndex
CREATE INDEX "AgencyMembership_creatorId_status_idx" ON "AgencyMembership"("creatorId", "status");

-- CreateIndex
CREATE INDEX "PKBattle_status_idx" ON "PKBattle"("status");

-- CreateIndex
CREATE INDEX "PKScoreConfig_countryCode_active_idx" ON "PKScoreConfig"("countryCode", "active");

-- CreateIndex
CREATE UNIQUE INDEX "GameRegionConfig_gameCode_countryCode_key" ON "GameRegionConfig"("gameCode", "countryCode");

-- CreateIndex
CREATE INDEX "GameRound_gameCode_status_idx" ON "GameRound"("gameCode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GameEntry_idempotencyKey_key" ON "GameEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GameEntry_roundId_idx" ON "GameEntry"("roundId");

-- CreateIndex
CREATE INDEX "GameEntry_userId_idx" ON "GameEntry"("userId");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
