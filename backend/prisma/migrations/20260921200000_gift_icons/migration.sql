-- AlterTable
ALTER TABLE "Gift" ADD COLUMN     "icon" TEXT;

-- The existing gift gets its icon, and the catalogue grows beyond Rose.
-- (Prices are a starting point: change them in the admin, under Gifts.)
UPDATE "Gift" SET "icon" = '🌹' WHERE "code" = 'ROSE';

INSERT INTO "Gift" ("id", "code", "name", "coinPrice", "category", "active", "createdAt", "icon") VALUES
  (gen_random_uuid()::text, 'HEART', 'Heart', 20, 'classic', true, CURRENT_TIMESTAMP, '❤️'),
  (gen_random_uuid()::text, 'KISS', 'Kiss', 50, 'classic', true, CURRENT_TIMESTAMP, '💋'),
  (gen_random_uuid()::text, 'TEDDY', 'Teddy Bear', 100, 'classic', true, CURRENT_TIMESTAMP, '🧸'),
  (gen_random_uuid()::text, 'CROWN', 'Crown', 200, 'classic', true, CURRENT_TIMESTAMP, '👑'),
  (gen_random_uuid()::text, 'RING', 'Diamond Ring', 500, 'classic', true, CURRENT_TIMESTAMP, '💍'),
  (gen_random_uuid()::text, 'CAR', 'Sports Car', 1000, 'classic', true, CURRENT_TIMESTAMP, '🏎️'),
  (gen_random_uuid()::text, 'ROCKET', 'Rocket', 2000, 'classic', true, CURRENT_TIMESTAMP, '🚀'),
  (gen_random_uuid()::text, 'LION', 'Lion', 5000, 'classic', true, CURRENT_TIMESTAMP, '🦁'),
  (gen_random_uuid()::text, 'CASTLE', 'Castle', 10000, 'classic', true, CURRENT_TIMESTAMP, '🏰')
ON CONFLICT ("code") DO NOTHING;
