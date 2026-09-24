-- Calibrate Lucky Number stake weights without changing the probability-derived multipliers.
-- Existing rounds keep their recorded rulesVersion; only the current game definition is upgraded.
UPDATE "GameDefinition"
SET "rulesJson" = jsonb_set("rulesJson", '{stakeWeightExponent}', '1.2798473'::jsonb, true),
    "version" = "version" + 1
WHERE "code" = 'SUM_DICE'
  AND ("rulesJson" ? 'rtp')
  AND ("rulesJson" ? 'basePrize')
  AND NOT ("rulesJson" ? 'stakeWeightExponent');
