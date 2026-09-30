RRYDA AUTH / LOGIN + REGISTRATION FIX

Changed files:
- src/auth/auth.service.ts
- src/auth/auth.controller.ts (included for deployment consistency)

What this fixes:
1. Registration/login normalize email with trim + lowercase, preventing case/space mismatches.
2. Audit and login-event telemetry are now best-effort. A missing/broken telemetry table/column can no longer turn a valid registration or login into a generic failure after the user/password is already valid.
3. The existing Argon2 password hashing remains unchanged.
4. Welcome email remains non-blocking because EmailService already swallows provider failures.
5. Do NOT copy the old dist folder back over the new build. Rebuild it from src.

DEPLOYMENT (backend directory):
  npm install
  npx prisma generate
  npx prisma migrate deploy
  npm run build
  npm run start:prod

IMPORTANT:
- Run `npx prisma migrate deploy` against the SAME DATABASE_URL used by the running backend.
- If migration deploy reports a failed/pending migration, stop there and fix that migration before testing auth.
- The project contains future-dated migrations after 2026-09-30. Do not blindly apply future migrations if your deployment process is intentionally frozen at an earlier release; apply the migrations belonging to the deployed release.
- After rebuilding, verify that dist/src/auth/auth.service.js has a newer timestamp than the previous dist build.

EXPECTED TESTS:
- Register a new email -> account + tokens returned.
- Login using the same email/password -> tokens returned.
- Login with wrong password -> Invalid credentials.
- Register same email again -> Email already registered.
