# Launch Readiness — Acceptance Criteria Status

Maps spec §93's acceptance criteria to what's actually true in this codebase
right now. Update this file as gaps close — don't let it drift into
aspirational copy. "Done" here means "code exists and was reasoned through
carefully," not "verified end-to-end against a running Postgres/Redis" —
see the README's "Before you run this" section for what's still unverified
in this environment specifically.

## Wallet

- [x] **Client cannot modify balance.** `WalletService` is the only code
  path that writes `Wallet.balance`; nothing else touches it.
- [x] **Duplicate transactions are prevented.** Every credit/debit requires
  an `idempotencyKey`, enforced by a unique DB constraint plus an
  up-front `findUnique` short-circuit for the common sequential-retry case.
  Tested in `wallet.service.spec.ts`.
- [x] **Ledger is auditable.** Every movement writes a `LedgerEntry` with
  `balanceAfter`, `reference`, and `type`.
- [x] **Reconciles in practice.** `ReconciliationService` (via
  `GET /api/v1/admin/reconciliation`) sums `LedgerEntry` per wallet and
  compares to `Wallet.balance` — the pure comparison logic
  (`reconcileWallet`) is directly tested. Not yet automated: nothing runs
  this on a schedule or alerts on a discrepancy; it's callable on demand.

## Gifts

- [x] **Cannot spend more than available.** `WalletService.debit` rejects
  when the resulting balance would go negative.
- [x] **Duplicate requests cannot double-charge.** Covered by the same
  idempotency mechanism as Wallet, tested in `gift.service.spec.ts`.

## Games

- [x] **Client cannot control outcome.** `RngService` uses `crypto.randomInt`
  server-side only; commit/reveal via `commitmentHash`/`revealData`.
- [x] **Round cutoff is enforced.** `RoundService.assertAcceptingEntries`
  checks both round status AND `lockAt` against the current time — not
  status alone.
- [x] **Results are immutable.** `SettlementService.settle` is a no-op if
  the round is already `SETTLED`; nothing else in the codebase writes to
  `GameRound.result` after that.
- [x] **Settlement is idempotent.** Same mechanism as above.
- [x] **Win/loss logic is correct.** `isWinningSelection` is a pure,
  directly-tested function (`settlement.service.spec.ts`).

## Creator

- [x] **Earnings correctly calculated.** Split math is tested
  (`gift-split.spec.ts`, including the agency-commission path) and
  exhaustively checked not to leak or invent coins across 1–1000 coin
  amounts. Not yet checked: creator-program split overrides (only
  GLOBAL/COUNTRY scope exist).
- [x] **Withdrawal cannot exceed cleared balance.** `WithdrawalService.request`
  checks `CREATOR_EARNINGS` balance before reserving.

## PK

- [x] **Winner is server-authoritative.** `PkService.settleIfDue` computes
  the winner from stored scores; the client never supplies one.

## Security

- [x] **Admin APIs protected by RBAC.** `RolesGuard` + `@Roles(...)` on every
  admin-scoped controller/route.
- [x] **Sensitive actions audited.** `AuditService.record` called on
  register/login, suspend/ban, regional config changes, flag toggles,
  withdrawal approve/reject, agency approve, creator application review.

## Global

- [x] **Region controls work server-side.** `RoundService.assertGameAvailable`
  checks both `RegionalConfig.gamesEnabled` AND a per-game
  `GameRegionConfig` row — a client can't bypass either by hiding UI.

## Not yet gated by this checklist (out of scope for §93 but worth tracking)

- **Risk engine now exists** (`src/risk/`) and covers all 6 signals listed
  in spec §54: account age, KYC status (manually set, no verification
  provider), withdrawal velocity, a lifetime-earnings ratio as a gift-
  pattern proxy, chargeback history (`ChargebackService` + a
  `Chargeback` table, fed by the payment webhook), and a device/IP signal
  (`LoginEvent` table — IP-overlap only, not a real device fingerprint, so
  it's a weaker signal than the others and shouldn't trigger review alone).
- **Agency commission settlement now exists**, wired directly into the gift
  flow (real-time, not batched) — see the design-decision comment at the
  top of `computeGiftSplit` in `gift.service.ts` for the assumption it
  makes (commission comes out of the creator's pool, not the platform's).
- No KYC verification *provider* integration — `User.kycVerified` is a
  manually-set flag an admin toggles, not the output of an actual check.
- No load testing has been run (§92) — nothing in this codebase has been
  exercised under concurrent load; the idempotency mechanisms are designed
  for it (unique constraints, not application-level locks) but that's a
  design claim, not a load-test result.
- No BullMQ job failure/retry tuning (jobs currently throw and log rather
  than following a defined retry policy).

## Global economy controls added in v5

- Coin packages are now editable per country from Admin → Coin packages.
- Withdrawal rules now support per-country daily/monthly limits, manual-review thresholds, cooldown hours and allowed payout providers.
- Lucky Number / Sum Dice supports optional per-number payout multipliers (0–27 for the default 3d10 game), validated server-side against number probability.
- Country payment rails remain configurable per country (Nigeria can use Paystack/C2C; other countries can use Crypto/C2C), while actual Crypto/C2C settlement remains disabled until a real provider/escrow implementation is connected.
