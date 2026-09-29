-- Fixes a live bug: GiftService.send() already increments RoomSeat.giftCoins on every gift sent
-- to a seated Party Room guest, inside the same transaction as the wallet debit/credit and the
-- GiftTransaction record. Without this column, that call throws a Prisma validation error and
-- rolls back the ENTIRE transaction — meaning gifts sent to anyone sitting in a Party Room seat
-- have been failing outright, not just failing to update a display number.
ALTER TABLE "RoomSeat" ADD COLUMN IF NOT EXISTS "giftCoins" INTEGER NOT NULL DEFAULT 0;
