-- Auto Assign / Manual Select toggle for the seat queue (see RoomsService.releaseSeat).
-- Defaults to true: this is the behavior the app already promised in its own alert copy
-- ("will be seated automatically when an unlocked seat becomes available") but never actually
-- implemented — releaseSeat freed the seat and did nothing else. Defaulting to true means every
-- existing room's behavior actually becomes what users were already told it was, rather than
-- silently changing behavior for rooms that never asked for this.
ALTER TABLE "PartyRoom" ADD COLUMN "autoAssignSeats" BOOLEAN NOT NULL DEFAULT true;
