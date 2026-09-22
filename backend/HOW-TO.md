# Add coins to a user

Copy `backend/*` into `C:\rydaapp\backend` (adds `scripts/grant-coins.ts`, `src/admin/grant-coins.ts` and one line in package.json).

## One-time setup (to reach the Render database from your PC)
1. Render dashboard -> your PostgreSQL database -> **External Database URL** (not the internal one). Copy it.
2. In `C:\rydaapp\backend\.env`, set `DATABASE_URL=` to that URL (keep your old value somewhere; put it back afterwards if you use the file for local development).
3. `npx prisma generate` (once, so the local client matches the schema).

## Add the coins
Preview first (changes nothing):
    npm run admin:coins -- donchris4life2006@gmail.com 1000

Then really do it — put the word  apply  at the end:
    npm run admin:coins -- donchris4life2006@gmail.com 1000 apply note=support gift

- Do NOT use `--yes` or `--note` with `npm run` on Windows: npm swallows them and the run is only a preview (that is what happened before). The plain words `apply`, `bonus` and `note=...` are safe. (If you run `npx ts-node scripts/grant-coins.ts ...` directly, the dashed forms work too.)
- Normal coins (spendable on gifts and games) are the default. Add the word `bonus` for game-only bonus coins.
- The person must already have registered in the app; the email is not case-sensitive.
- Whole numbers from 1 to 10,000,000 only.
- It is recorded in the ledger as an adjustment with your note, and in the audit log. The balance and ledger always agree.
- The coins show up the next time their wallet refreshes (pull to refresh, or reopen the app).
