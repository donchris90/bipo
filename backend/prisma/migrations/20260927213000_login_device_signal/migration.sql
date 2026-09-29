ALTER TABLE "LoginEvent" ADD COLUMN "deviceIdHash" TEXT;
CREATE INDEX "LoginEvent_deviceIdHash_idx" ON "LoginEvent"("deviceIdHash");
