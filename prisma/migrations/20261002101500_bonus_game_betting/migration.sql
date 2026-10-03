ALTER TABLE "LudoSpectatorBet" ADD COLUMN IF NOT EXISTS "bonusAmount" INTEGER NOT NULL DEFAULT 0;
-- AyoSpectatorBet is created later (20261009090000); a fresh database picks this column up in 20261010085000_fresh_db_catchup.
DO $$ BEGIN IF to_regclass('"AyoSpectatorBet"') IS NOT NULL THEN ALTER TABLE "AyoSpectatorBet" ADD COLUMN IF NOT EXISTS "bonusAmount" INTEGER NOT NULL DEFAULT 0; END IF; END $$;
