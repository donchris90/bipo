-- Notify a host's followers and fellow agency members automatically when the host goes live or
-- opens a party room (see common/friend-announce.ts).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FOLLOWED_HOST_LIVE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FOLLOWED_HOST_ROOM';
