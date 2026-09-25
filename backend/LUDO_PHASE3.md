# Ludo Phase 3 — Persistent Matchmaking & Invitations

## Included
- Quick Match queue is mirrored to Redis with a 10-minute TTL.
- Private room codes are mirrored to Redis with a 1-hour TTL, so a backend restart does not erase waiting rooms.
- Active Ludo states remain durably persisted in `GameRound.hiddenState`.
- Ludo bot/turn ticking reloads active Ludo rounds from PostgreSQL instead of only looking at in-memory matches.
- Redis per-match tick locks prevent two backend instances from advancing the same match simultaneously.
- Ludo room invitations can be created and listed through authenticated API endpoints.
- Existing wallet debit/credit remains server-side and idempotent.

## API
- `POST /api/v1/ludo/quick-match`
- `POST /api/v1/ludo/rooms`
- `POST /api/v1/ludo/rooms/:roomCode/join`
- `POST /api/v1/ludo/matches/:matchId/invite` body `{ "toUserId": "..." }`
- `GET /api/v1/ludo/invites`
- `GET /api/v1/ludo/matches/:matchId`
- `POST /api/v1/ludo/matches/:matchId/reconnect`

## Important deployment note
Redis is used for matchmaking/room coordination, while PostgreSQL remains the durable source of truth for paid match state and wallet settlement. If Redis is temporarily unavailable, the service falls back to the local process queue/room map; production should keep Redis healthy because multi-instance coordination requires it.
