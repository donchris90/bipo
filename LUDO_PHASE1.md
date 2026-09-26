# Ludo Phase 1

Implemented in the current project:

- Paid coin-only Ludo; no free-play mode.
- 2-player and 4-player matches.
- Quick Match by exact entry fee + player count.
- Private room creation/join by room code for friends and agency players.
- Agency-member discovery endpoint for creators who belong to an agency.
- Server-authoritative dice, movement, captures, turns and settlement.
- Six gives an extra turn.
- Three consecutive sixes cancel the third six and pass the turn.
- 2-player matches pay only 1st place (100% of the player pool).
- 4-player matches pay 1st and 2nd place (default 66.67% / 33.33%).
- Wallet debit and prize credit use the existing idempotent wallet ledger.
- Reconnection returns the same player to the same match.
- A disconnected player's turn is temporarily controlled by the server-side bot after the normal turn timer expires.
- Game state is persisted in GameRound.hiddenState so an active match can be recovered after a process restart.
- Admin Game settings now recognize LUDO and expose minimum/maximum entry, turn time, reconnect grace, and first/second prize percentages.
- Ludo is seeded DISABLED by default. Admin must enable the game and its country region before users can play.

## Current deliberate limits

- Matchmaking queues are in process memory; the durable match itself is stored in the database. For a multi-instance production deployment, move matchmaking/active-room coordination to Redis.
- The first mobile UI uses a clean functional board representation. The final production board artwork/animation can be refined after the multiplayer engine is accepted.
- Agency invitations currently use the same private-room code flow; a direct push/in-app invite can be added next.
