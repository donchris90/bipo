-- "New season started" push (SeasonAutoStartService): startNotifiedAt is the once-only guard
-- for the broadcast, the same role settledAt already plays for settlement.
ALTER TABLE "Season" ADD COLUMN "startNotifiedAt" TIMESTAMP(3);
