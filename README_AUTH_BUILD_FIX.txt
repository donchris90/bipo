RYDA AUTH + BUILD BLOCKER FIX

1. The TypeScript error `TS2688: Cannot find type definition file for http-cache-semantics` is caused by TypeScript automatically discovering the transitive @types/http-cache-semantics package. tsconfig.json now explicitly limits automatic global type discovery to Node for the backend build.

2. Auth email input is normalized (trim/lowercase) on registration and login.

3. Audit and login-event telemetry are treated as non-critical. A database problem in those telemetry tables no longer turns a successfully created account into `Registration failed`, or a valid password into a login failure. Errors are logged for diagnosis.

DEPLOY
cd backend
npm install
npx prisma generate
npx prisma migrate deploy
npm run build
npm run start:prod

If `prisma migrate deploy` fails, stop and send that exact output. Do not reset/drop the database.
