-- Advanced PK metadata: existing NORMAL battles keep the original behavior.
ALTER TABLE "PKBattle" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "PKBattle" ADD COLUMN "challengerTeamId" TEXT;
ALTER TABLE "PKBattle" ADD COLUMN "opponentTeamId" TEXT;

CREATE INDEX "PKBattle_mode_idx" ON "PKBattle"("mode");
CREATE INDEX "PKBattle_challengerTeamId_idx" ON "PKBattle"("challengerTeamId");
CREATE INDEX "PKBattle_opponentTeamId_idx" ON "PKBattle"("opponentTeamId");
