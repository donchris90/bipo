ALTER TABLE "User" ADD COLUMN "hostXp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "hostLevel" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "HostLevel" (
  "level" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "xpRequired" INTEGER NOT NULL,
  "unlocks" JSONB,
  "badgeUrl" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostLevel_pkey" PRIMARY KEY ("level")
);
CREATE TABLE "HostXpRule" (
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "xpPerUnit" INTEGER NOT NULL DEFAULT 1,
  "unit" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostXpRule_pkey" PRIMARY KEY ("key")
);

INSERT INTO "HostLevel" ("level","name","xpRequired","unlocks") VALUES
(1,'New Host',0,'["SOLO_LIVE"]'),
(2,'Rising Host',100,'[]'),
(3,'Active Host',300,'["ONE_ON_ONE_AUDIO"]'),
(4,'Popular Host',600,'[]'),
(5,'Gold Host',1000,'["ONE_ON_ONE_VIDEO"]'),
(6,'Star Host',1500,'[]'),
(7,'Super Host',2100,'[]'),
(8,'Elite Host',2800,'[]'),
(9,'Premium Host',3600,'[]'),
(10,'Legend Host',4500,'["PREMIUM_ONE_ON_ONE"]');

INSERT INTO "HostXpRule" ("key","label","xpPerUnit","unit") VALUES
('LIVE_MINUTE','Live hosting',1,'minute'),
('GIFT_100_COINS','Gift received',1,'100 coins'),
('PRIVATE_MINUTE','1-on-1 hosting',2,'minute'),
('DAILY_TASK','Host task completed',25,'task');
