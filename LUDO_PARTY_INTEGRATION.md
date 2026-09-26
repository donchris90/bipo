# Party Room Ludo integration

- A Party Room host can start a paid Ludo table from the room's tools.
- The Ludo table is associated with the Party Room through a short-lived Redis room mapping.
- Party members must be seated in the Party Room before they can join the Party Ludo table.
- The existing Ludo server remains authoritative for entry debits, turns, AI takeover and settlement.
- The normal Ludo prize rules remain unchanged: 2-player = 100% to first; 4-player = 66.67% first / 33.33% second.
- Spectator prediction/betting is intentionally not mixed into the player entry pool or this integration path.
