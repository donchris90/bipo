ALTER TABLE "GameEntry" ADD COLUMN "netAmount" INTEGER NOT NULL DEFAULT 0;

-- Upgrade the existing SUM_DICE definition to the formula-driven Lucky Number
-- rules only when it is still on the old flat-multiplier configuration.
UPDATE "GameDefinition"
SET "name" = 'Lucky Number',
    "rulesJson" = jsonb_build_object(
      'rtp', 0.95,
      'basePrize', 1000,
      'stakeWeightExponent', 1.2798473,
      'diceCount', 3,
      'diceSides', 10,
      'openSeconds', 30,
      'minStake', 1,
      'maxStake', 1000000
    ),
    "version" = "version" + 1
WHERE "code" = 'SUM_DICE'
  AND ("rulesJson" ? 'payoutMultiplier');
