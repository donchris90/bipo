-- Yoruba, Hausa and Igbo are no longer offered (Nigeria uses English). Move anyone who had them to English.
UPDATE "User" SET "languageCode" = 'en' WHERE "languageCode" IN ('yo', 'ha', 'ig');
