# RydaApp Economy / Spending Fixes

Source: `updatedscript.zip`

## Applied

### 1. Paid-call concurrent billing protection
`src/calls/calls.service.ts`

Paid-call settlement now locks the `Call` database row with `FOR UPDATE` and re-reads `billedMinutes` inside the same transaction that performs the wallet debit/creator/platform ledger movements.

This closes the race where two simultaneous billing requests could both observe the same `billedMinutes` and increment `Call.totalCoins` twice even though the wallet debit was idempotent.

### 2. Configurable PK winner bonus
`prisma/schema.prisma`

`PKScoreConfig` now contains:

- `winnerRewardCoins Int @default(500)`

Migration:

- `prisma/migrations/20261002093000_configurable_pk_winner_reward/migration.sql`

The existing 500 BONUS reward remains the default, so current behavior is preserved until an administrator changes it.

### 3. PK admin configuration API
`src/pk/pk.service.ts`
`src/pk/pk.controller.ts`

Added authenticated admin endpoints:

- `GET /api/v1/pk/admin/winner-reward`
- `POST /api/v1/pk/admin/winner-reward` with `{ "winnerRewardCoins": 500 }`

Access is restricted to `SUPER_ADMIN` and `GAME_OPERATOR`.

The reward remains in the `BONUS` wallet and therefore does not become withdrawable creator earnings.

## Validation

The extracted backend did not contain `node_modules`. An install attempt could not complete within the execution environment, so a full Nest/Prisma TypeScript build could not be completed here.

The Prisma migration and source changes are included and should be run through the project's normal CI/build environment before deployment.
