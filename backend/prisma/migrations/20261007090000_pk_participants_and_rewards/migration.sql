-- Late-joiner fix: Team/Agency PK now snapshots participant ids once at challenge time instead of
-- checking live membership at gift time — closes a real exploit (joining a team/agency mid-battle
-- to add gifting surface to its score).
ALTER TABLE "PKBattle" ADD COLUMN "challengerParticipantIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PKBattle" ADD COLUMN "opponentParticipantIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Winner coin reward, paid once at settlement.
ALTER TABLE "PKBattle" ADD COLUMN "rewardCoinsPaid" BOOLEAN NOT NULL DEFAULT false;
