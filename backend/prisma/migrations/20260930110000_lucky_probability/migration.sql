-- Normalize the bundled Lucky Gift catalog from legacy weight-based rows to explicit probability percentages.
UPDATE "Gift"
SET "luckyRewards" = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'label', x->>'label',
      'coins', ((x->>'coins')::int),
      'probability', ROUND((((x->>'weight')::numeric / totals.total_weight) * 100)::numeric, 4)
    )
  )
  FROM jsonb_array_elements("Gift"."luckyRewards") AS x
  CROSS JOIN LATERAL (
    SELECT SUM((z->>'weight')::numeric) AS total_weight
    FROM jsonb_array_elements("Gift"."luckyRewards") AS z
  ) totals
  WHERE x ? 'weight'
)
WHERE "luckyEnabled" = true
  AND "luckyRewards" IS NOT NULL
  AND jsonb_typeof("luckyRewards") = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements("luckyRewards") e WHERE e ? 'weight');
