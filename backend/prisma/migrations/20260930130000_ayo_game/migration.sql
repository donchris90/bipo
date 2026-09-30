-- Register Ayo as a disabled paid game.
INSERT INTO "GameDefinition"
("code","name","status","version","rulesJson","createdAt","updatedAt")
VALUES (
  'AYO',
  'Ayo',
  'DISABLED',
  1,
  '{"minEntry":100,"maxEntry":500000,"turnSeconds":30,"prizePercent":95,"captureMode":"FOUR"}'::jsonb,
  NOW(),
  NOW()
)
ON CONFLICT ("code") DO NOTHING;