CREATE TABLE "ModerationRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "phrase" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "severity" INTEGER NOT NULL DEFAULT 1,
  "action" TEXT NOT NULL DEFAULT 'BLOCK',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "ModerationRule_active_category_idx" ON "ModerationRule"("active", "category");

CREATE TABLE "ModerationViolation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "context" "ChatContext" NOT NULL,
  "contextId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "severity" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "matchedRuleId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ModerationViolation_userId_createdAt_idx" ON "ModerationViolation"("userId", "createdAt");
CREATE INDEX "ModerationViolation_context_contextId_createdAt_idx" ON "ModerationViolation"("context", "contextId", "createdAt");

-- Safe starter rules. Admins can add, disable or change rules without a mobile release.
INSERT INTO "ModerationRule" ("id","phrase","category","severity","action","active","createdAt","updatedAt") VALUES
(gen_random_uuid()::text,'fuck','PROFANITY',1,'BLOCK',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'shit','PROFANITY',1,'BLOCK',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'bitch','PROFANITY',1,'BLOCK',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'asshole','PROFANITY',1,'BLOCK',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'motherfucker','PROFANITY',1,'BLOCK',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'cunt','PROFANITY',2,'MUTE',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'kill yourself','HARASSMENT',3,'MUTE',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'i will kill you','THREAT',4,'KICK',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'send me money','SCAM',2,'MUTE',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
(gen_random_uuid()::text,'send coins and i will','SCAM',2,'MUTE',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
