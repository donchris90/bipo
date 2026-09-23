-- Guest seats are open by default. Seat locks are now explicit host/moderator actions.
-- This clears locks created by the previous "all guest seats locked" behavior.
DELETE FROM "RoomSeatLock";
