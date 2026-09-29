-- Family/Guild PK: mirrors the existing challengerTeamId/opponentTeamId columns exactly, at the
-- agency level. Purely additive.
ALTER TABLE "PKBattle" ADD COLUMN "challengerAgencyId" TEXT;
ALTER TABLE "PKBattle" ADD COLUMN "opponentAgencyId" TEXT;
