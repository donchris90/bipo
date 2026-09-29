-- First-run onboarding: pick interests, follow a few people.
ALTER TABLE "User" ADD COLUMN "onboardedAt" TIMESTAMP(3);

-- IMPORTANT: everyone who already has an account has, by definition, found their way around.
-- Backfill them so only accounts created AFTER this migration are sent through onboarding.
UPDATE "User" SET "onboardedAt" = "createdAt" WHERE "onboardedAt" IS NULL;

CREATE TABLE "Interest" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Interest_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "UserInterest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "interestKey" TEXT NOT NULL,
    CONSTRAINT "UserInterest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserInterest_userId_interestKey_key" ON "UserInterest"("userId", "interestKey");
CREATE INDEX "UserInterest_userId_idx" ON "UserInterest"("userId");

ALTER TABLE "UserInterest" ADD CONSTRAINT "UserInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserInterest" ADD CONSTRAINT "UserInterest_interestKey_fkey" FOREIGN KEY ("interestKey") REFERENCES "Interest"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "Interest" ("key","label","emoji") VALUES
('MUSIC','Music','🎵'),
('COMEDY','Comedy','😂'),
('GAMING','Gaming','🎮'),
('SPORTS','Sports','⚽'),
('RELATIONSHIPS','Relationships','❤️'),
('BUSINESS','Business','💼'),
('LATE_NIGHT','Late Night','🌙'),
('LOCAL','Local Community','📍')
ON CONFLICT ("key") DO NOTHING;
