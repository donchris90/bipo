CREATE TABLE "HostDailyTask" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "activityKey" TEXT NOT NULL,
  "targetUnits" INTEGER NOT NULL,
  "rewardXp" INTEGER NOT NULL DEFAULT 25,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostDailyTask_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HostDailyTask_key_key" ON "HostDailyTask"("key");
CREATE TABLE "HostDailyTaskProgress" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "HostDailyTaskProgress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HostDailyTaskProgress_userId_taskId_day_key" ON "HostDailyTaskProgress"("userId","taskId","day");
CREATE INDEX "HostDailyTaskProgress_userId_day_idx" ON "HostDailyTaskProgress"("userId","day");
ALTER TABLE "HostDailyTaskProgress" ADD CONSTRAINT "HostDailyTaskProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HostDailyTaskProgress" ADD CONSTRAINT "HostDailyTaskProgress_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HostDailyTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "HostDailyTask" ("id","key","label","activityKey","targetUnits","rewardXp") VALUES
  ('host-task-live-30','LIVE_30_MIN','Host for 30 minutes','LIVE_MINUTE',30,25),
  ('host-task-gift-1000','GIFT_1000_COINS','Receive 1,000 gift coins','GIFT_100_COINS',10,50),
  ('host-task-private-10','PRIVATE_10_MIN','Complete 10 minutes of 1-on-1 hosting','PRIVATE_MINUTE',10,50)
ON CONFLICT ("key") DO NOTHING;
