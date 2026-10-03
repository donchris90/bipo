ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nearbyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nearbyLat" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nearbyLon" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nearbyUpdatedAt" TIMESTAMP(3);
-- CreatorSupporter is created later (20260928090000); a fresh database picks this column up in 20261010085000_fresh_db_catchup.
DO $$ BEGIN IF to_regclass('"CreatorSupporter"') IS NOT NULL THEN ALTER TABLE "CreatorSupporter" ADD COLUMN IF NOT EXISTS "fanClubJoinedAt" TIMESTAMP(3); END IF; END $$;
CREATE INDEX IF NOT EXISTS "User_nearbyEnabled_idx" ON "User"("nearbyEnabled");
CREATE INDEX IF NOT EXISTS "User_nearbyUpdatedAt_idx" ON "User"("nearbyUpdatedAt");
