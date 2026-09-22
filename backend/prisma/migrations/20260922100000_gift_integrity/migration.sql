-- Immutable gift money snapshots. Nullable to preserve existing historical rows;
-- all newly-created GiftTransaction rows populate these fields.
ALTER TABLE "GiftTransaction"
  ADD COLUMN "creatorShareCoins" INTEGER,
  ADD COLUMN "platformShareCoins" INTEGER,
  ADD COLUMN "agencyShareCoins" INTEGER,
  ADD COLUMN "creatorShareBps" INTEGER,
  ADD COLUMN "platformShareBps" INTEGER,
  ADD COLUMN "agencyCommissionBps" INTEGER,
  ADD COLUMN "agencyId" TEXT,
  ADD COLUMN "agencyOwnerId" TEXT;

-- A creator is allowed to have only one active agency membership. The
-- application already enforces this rule, but concurrent recruitment requests
-- must not be able to violate it.
CREATE UNIQUE INDEX "AgencyMembership_one_active_creator_idx"
  ON "AgencyMembership" ("creatorId")
  WHERE "status" = 'ACTIVE';
