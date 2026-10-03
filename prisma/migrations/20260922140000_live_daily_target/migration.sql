-- Duplicate of 20260922080000_live_daily_target; idempotent so a fresh database replays cleanly.
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "dailyTargetCoins" INTEGER;
