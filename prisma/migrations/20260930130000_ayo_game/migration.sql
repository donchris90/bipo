-- Register Ayo/Ayò Ọlọ́pón as a disabled paid game.
INSERT INTO "GameDefinition" ("code","name","status","version","rulesJson")
VALUES ('AYO','Ayo','DISABLED',1,'{"minEntry":100,"maxEntry":500000,"turnSeconds":30,"prizePercent":95,"captureMode":"FOUR"}'::jsonb)
ON CONFLICT ("code") DO NOTHING;
