# Rryda backend compile + auth fix

The supplied backend log contained 28 TypeScript errors. This package fixes the reported compile blockers, including:

- gifter `tierFor` export
- NOWPayments `VerifyPaymentResult` shape
- Ayo WebSocket `OnModuleDestroy` import and user-id narrowing
- Ayo seat typing
- Lucky Number incorrect relative imports and transaction typing
- Lucky Number guard imports
- Ludo Prisma JSON state typing
- Journey streak result narrowing
- payout nullable JSON handling and provider-array typing
- Rooms controller required/optional parameter order
- duplicate supporter `xp` property
- implicit `http-cache-semantics` type-library loading by limiting TypeScript global types to Node

Auth was also hardened: email is normalized, registration/login telemetry failures no longer make an otherwise valid account/login fail, and the welcome email is non-blocking.

## Deploy

```powershell
npm install
npx prisma generate
npx prisma migrate deploy
npm run build
npm run start:prod
```

Do not run the old `dist` build without rebuilding.

If `prisma migrate deploy` fails, stop and keep the database intact; the migration error is needed to diagnose the schema mismatch.
