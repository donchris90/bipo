# Platform Backend — Phases 0–8, plus testing (9) and launch readiness (10)

Phase 0 (stack/config) through Phase 8 (Global rollout config), plus a
testing foundation and an honest launch-readiness checklist. Meant to run
and be extended, not just read. See `LAUNCH_CHECKLIST.md` for current
acceptance-criteria status.

## ⚠️ Before you run this

Two things download/connect outside this sandbox's allowed network domains,
so neither could be fully verified here:

1. `prisma generate` downloads a query-engine binary from
   `binaries.prisma.sh` — blocked in this sandbox.
2. The scheduler (BullMQ) needs a running Redis instance — also not
   available here, so `JobsService`'s workers have never actually connected
   to Redis or processed a real job.

**The code has been hand-reviewed and type-checked as far as possible
without those, but not fully compiled or run.** Do this first:

```bash
npm install
cp .env.example .env    # fill in real secrets, DATABASE_URL, REDIS_URL
npx prisma generate
npx tsc --noEmit        # confirm it's clean in your environment
```

You'll also need Redis running locally (`docker run -p 6379:6379 redis` is
the fastest way) for PK/game-round auto-transitions to work — without it,
`QueueModule`'s producers will fail when `PkService.accept()` or
`RoundService.createRound()` try to enqueue a job.

If `tsc` surfaces errors, they'll almost all be places where a Prisma-typed
value needs an explicit annotation (the sandbox run turned up several of
these already and they're fixed — see git history / comments) — genuine
logic bugs are far less likely than typing friction, but check before you
trust it in production.

## What's here

- **Auth**: register/login/refresh/logout, Argon2id password hashing, JWT access
  tokens (short-lived) + rotating refresh tokens (hashed at rest, revoked on use).
- **RBAC**: 9 roles from the spec (`GUEST` → `SUPER_ADMIN`), enforced via
  `@Roles(...)` + `RolesGuard` on top of `JwtAuthGuard`.
- **Regional Config**: single source of truth per country (`currencyCode`,
  `minAge`, `gamesEnabled`, `paymentsEnabled`, `active`). Every later module
  (payments, gifts, games) should gate against this table, server-side, rather
  than re-implementing country logic inline.
- **Feature Flags**: the emergency kill-switches from spec §84
  (`DISABLE_PAYMENTS`, `DISABLE_GAMES`, etc.), settable only by `SUPER_ADMIN`.
- **Audit Log**: every sensitive action (register, login, suspend/ban,
  regional config change, flag toggle) writes an `AuditLog` row.
- **Social**: follow/unfollow, block/unblock (severs any existing follow both
  ways), mute/unmute. Following a blocked (or blocking) user is rejected.
- **Notifications**: in-app only for now — `NotificationsService.create()` is
  the single seam every future module (gifts, PK invites, withdrawals) should
  call through, so push/email providers get wired in one place later, not
  scattered across modules.
- **Search**: users/displayName only. Intentionally not stubbing search for
  rooms/games/hashtags — those don't exist yet in this codebase.
- **Feed**: `following` (who you follow), `discover` (follower-count
  ranking as a bootstrap, falling back to newest accounts if the graph is
  empty), plus `for-you`/`new`/`nearby` — added after discovering the
  mobile app's `HomeScreen.tsx` referenced all three with no backend route
  behind them at all (a real gap, not just a missing mobile wrapper; see
  `feed.service.ts`'s comments on each — `forYou` is honestly identical to
  `discover` right now, `new`/`nearby` are genuinely distinct real
  queries). This is **not** the spec's full For You/Live Now/Trending —
  that needs real watch-time/engagement signals from Phase 3 (Live). Treat
  `discover`'s ranking (and `forYou`'s, since it's the same thing) as a
  placeholder to replace, not a feature to polish.
- **Live**: session lifecycle behind an `RtcProvider` interface (mock impl
  included — swap for Agora/LiveKit/100ms without touching `LiveService`).
- **Party Rooms**: create/seat/host-controls, moderation actions logged.
- **Realtime**: a Socket.IO gateway (`live:{id}`, `room:{id}` channels) for
  chat, JWT-authenticated on handshake, in-memory rate limiting.
- **Wallet/Ledger**: `WalletService` is the *only* place any balance changes
  anywhere in the codebase — every credit/debit is idempotent (unique
  `idempotencyKey`), transactional, and stored in minor units as `BigInt`
  (never float/double). Every other financial module routes through it.
- **Coin purchases & Gifts**: server-verified purchase confirmation via a
  `PaymentProvider` interface (mock impl); gift-send debits sender, splits
  to recipient + platform by configurable `RevenueSplitConfig` (never
  hard-coded percentages). `GET /gifts` (catalog) added alongside this
  session's mobile work — before it, nothing let a client discover what
  `giftId` values were even valid to pass to the already-existing
  `POST /gifts/send`. A second real gap found later the same day:
  `RealtimeGateway.broadcastGift()` had existed and been fully
  implemented from the start, but **nothing anywhere ever called it** —
  a gift could be sent successfully with no one in the room ever seeing
  it happen live. `GiftController.send()` now calls it after a
  successful send (only when a real `context`/`contextId` is present),
  which required importing `RealtimeModule` into `EconomyModule` for the
  first time.
- **Creators**: application → approval (grants the `CREATOR` role) →
  withdrawal with reserve-then-release semantics via a `PayoutProvider`
  interface (mock impl).
- **Agencies**: register/approve/recruit-creator, one-active-membership
  enforced. Commission is now settled in real time off the gift flow (see
  `gift.service.ts`) rather than a deferred batch job.
- **PK Battles**: challenge/accept/countdown/active/settle, server-only
  winner calculation, score fed by `GiftService` when a gift is sent with a
  `pkBattleId`. `GET /pk/incoming` added while building the mobile PK UI —
  before it, a challenged user had no way to ever discover a challenge
  existed (`challenge()` fires no notification, and no list endpoint
  existed at all; `accept()` needs a battle id nothing gave them). Declared
  before the existing `@Get(':id')` in the controller specifically —
  NestJS matches routes in declaration order, so `:id` would otherwise
  swallow `/pk/incoming` as if `"incoming"` were a battle id.
  No matchmaking/random-opponent queue exists — only a direct challenge to
  a specific known user id. The reference app's Random PK/Team PK modes
  aren't backed by anything here.
- **Games**: a generic engine (`RngService` CSPRNG + commit/reveal,
  `RoundService` state machine, `EntryService`, `SettlementService`) with
  three games wired end to end: **Lucky Number** (pick N, draw N, exact-set
  match), **Sum Dice / Big-Small-Odd-Even** (3 dice summed to 0-27,
  player spreads a variable stake across any number of picks against that
  single result — the Small/Big boundary is confirmed 0-13/14-27, an even
  split, verified against the real app rather than inferred), and
  **Crash** (spec §44-46 — a continuously-rising multiplier players cash
  out of at any moment, or set an auto-cashout target; see
  `games/crash-rules.ts` for the full design, math, and a 200,000-trial
  statistical test confirming the house edge actually holds). Gated by
  both `RegionalConfig.gamesEnabled` and a per-game `GameRegionConfig` —
  both must be true. `GameAdminService` exists to create/configure/activate
  a game — this was missing entirely until the sum-dice work exposed the
  gap. `GET /api/v1/games/:gameCode/history` returns the round-by-round
  Time/Result/Winners/Prize table seen in the reference client, computed
  live from `GameEntry` rather than stored separately. Also added: live
  per-number pool totals (`rounds/:roundId/pool`), Small/Big/Odd/Even
  streak data (`:gameCode/stats`), and a biggest-wins feed
  (`:gameCode/big-wins`) — all read-time aggregations, all sum-dice-only
  (gated with an `applicable: false` response for non-sum-dice games like
  Lucky Number or Crash, where these concepts don't apply). One security
  fix that came out of building Crash: `GameRound.hiddenState` (where
  Crash's crash point lives before settlement) is now excluded from every
  client-facing round response via a shared `ROUND_SELECT` projection in
  `games.controller.ts` — worth knowing if you add a new round-read
  endpoint, since it's easy to forget and accidentally leak pre-settlement
  state by using a bare `findMany`/`findUnique` instead.
- **Scheduler**: BullMQ queues (`QueueModule`, producer side) + a worker
  (`JobsModule`) now automatically transition PK battles
  (COUNTDOWN→ACTIVE→SETTLED) and game rounds (SCHEDULED→OPEN→LOCKED→SETTLED)
  at the times set when they're created — no manual polling needed anymore.
  The manual endpoints (`activateIfDue`, `settleIfDue`, `open`, `lock`) still
  exist and are safe to call directly as a fallback.
- **Moderation enforcement**: `ModerationService` reads the most recent
  MUTE/UNMUTE and BAN/UNBAN action per user per room, so the realtime
  gateway now actually rejects chat from a muted/banned user, and
  `RoomsService.requestSeat` rejects a banned user trying to re-enter.
- **Global config (Phase 8)**: seed data now covers 8 starter countries
  (only NG active by default — the rest exist so the multi-country schema
  path is exercised without implying they're live). Added
  `GET /api/v1/regions` (public, unauthenticated) for app bootstrap, and
  `config/currency.util.ts` for correct minor-unit handling per currency
  (not every currency uses 2 decimal places — see the file comment).
- **A real bug found via live testing, now fixed codebase-wide**: a debit
  or credit that succeeded, immediately followed by a *separate* write
  (the record that justifies it — a `GameEntry`, a `GiftTransaction`, a
  `WithdrawalRequest`) that then failed, left real money moved with
  nothing to show for it. This is not hypothetical — it happened live
  during Crash testing and permanently cost a test account 100 coins with
  no trace. Root cause: `WalletService` opened its own transaction
  internally, so a caller doing "debit, then another write" had no way to
  make the two atomic. Fixed by adding an optional `tx` parameter to
  `WalletService.credit()`/`debit()`/`forceDebit()`/`recordPlatformEntry()`
  — when a caller passes their own `Prisma.TransactionClient` (from their
  own `$transaction(async (tx) => ...)`), the wallet operation runs inside
  it instead of opening a second one. Applied to `EntryService.place()`,
  `GiftService.send()`, and `WithdrawalService.request()` — the three
  confirmed-vulnerable call sites. **Not yet applied**: `CoinPurchaseService`,
  `CrashService` (both cash-out and settlement), and `SettlementService`
  have a milder version of the same shape (self-healing on retry via
  idempotency, since the credit won't double-apply, but still leaves
  inconsistent state — e.g. a paid entry stuck at `PLACED` instead of
  `WON` — if the second write fails). Worth the same fix before this
  handles real money at scale.
- **A regression of an earlier fix, caught the same day**: the transaction
  atomicity fix above (EntryService/GiftService/WithdrawalService each
  opening their own outer `$transaction`) silently reintroduced the
  geographic-latency timeout bug from earlier in this README — those new
  outer transactions used Prisma's default 5000ms timeout, not the
  extended one, because that value had only ever been set inline in one
  place (`WalletService`'s own internal transaction) rather than shared.
  Fixed by extracting `EXTENDED_TX_OPTIONS` into
  `prisma/prisma-transaction-options.ts` and importing it everywhere a
  `$transaction(...)` call exists, specifically so a future new call site
  can't make the same mistake by typing the timeout inline again.
- **The remaining money-loss fixes, closed out**: `CoinPurchaseService.confirm`,
  `CrashService` (both `cashOut` and the auto-cashout branch in
  `settleCrash`), `SettlementService.settle`, `WithdrawalService` (`reject`,
  `processPayout`'s failure branch, `confirmFailed`), and
  `ChargebackService.record` all had the same credit/debit-then-separate-write
  shape as the original bug, previously left as a known gap. All now use
  the same `tx` passthrough + `EXTENDED_TX_OPTIONS` pattern. Every
  `wallet.credit`/`debit`/`forceDebit` call site in the codebase was
  re-audited by hand (not just the ones that seemed likely) — none remain
  outside a shared transaction with whatever write depends on them.
- **A silent no-op bug, also caught live**: adding real Paystack support to
  the payment webhook controller replaced generic
  `paymentProvider.handleWebhook()` dispatch with Paystack-specific field
  access hardcoded directly in the controller — which silently broke the
  mock purchase flow the moment Paystack support landed. The webhook
  endpoint kept returning `{received: true}` with no error at all, but
  never actually called `confirm()`, so coins never credited. Caught
  during live Crash testing when a coin purchase's webhook "succeeded" but
  the wallet never moved. Fixed by routing back through each provider's
  own `handleWebhook()`, which already existed specifically to normalize
  this per provider — the bug was bypassing an abstraction that was
  already correct, not a missing one. Also had to make
  `MockPaymentProvider.verifyWebhookSignature()` return `true` instead of
  being unimplemented — leaving it unimplemented on the theory that "the
  mock's webhook path should be rejected" turned out to just silently
  block all local testing, which defeats the point of having a mock.
- **Real payment/RTC/email providers**: Paystack (payments), Agora (live
  RTC tokens), and Brevo (transactional email) are now real integrations,
  not just interfaces sitting on mocks. Each module falls back to its Mock
  provider with a loud startup warning if the relevant env vars aren't
  set — never silently. **None of these three have been tested against
  their live APIs from this sandbox** — that domain access simply doesn't
  exist here (same limitation as Prisma/Redis before, now extended to
  three more external services). Paystack's webhook signature verification
  (`verifyPaystackSignature`) is tested with real computed HMAC vectors —
  that part is genuinely verified. The actual HTTP calls to
  api.paystack.co / Agora's token service / api.brevo.com are written
  against each provider's public docs but have never round-tripped
  against a real server. Test with real credentials before trusting any
  of them with production traffic. One specific thing to double-check:
  the Paystack dispute/chargeback event name used in
  `payment-webhook.controller.ts` (`charge.dispute.create`) is a best
  guess from documentation, not confirmed live — verify it against
  Paystack's actual dashboard before relying on chargeback detection.
- Crypto payment provider: not yet built — no specific provider chosen yet.
- **Risk engine**: `RiskService` scores every withdrawal against all 6
  signals from spec §54 — account age, KYC status, withdrawal velocity,
  lifetime-earnings ratio, chargeback history, and shared-IP account
  overlap. See `LAUNCH_CHECKLIST.md` for how each is actually computed and
  where the honest limitations are (IP overlap is a weak signal on its own;
  KYC is manually set, not verified by a provider).
- **Chargebacks**: `ChargebackService` records disputes reported via the
  payment webhook and claws back the coin amount via
  `WalletService.forceDebit` — a deliberately dangerous, narrowly-scoped
  method that's allowed to push a wallet negative (since the coins may
  already be spent), unlike every other debit path in the codebase.
- **Reconciliation**: `GET /api/v1/admin/reconciliation` (Finance Admin /
  Super Admin) sums every wallet's ledger entries and flags any that don't
  match the stored balance. On-demand only — not yet run on a schedule or
  wired to an alert.
- **Two real module-wiring bugs found and fixed post-deploy**: `LiveModule`
  and `GamesModule` were missing imports for modules their services
  actually depend on (`FeatureFlagsModule`, `RegionalConfigModule`).
  NestJS only catches this at application bootstrap, not at `tsc` compile
  time — it passed every `tsc --noEmit` check in this repo's history and
  only surfaced when the app was actually started against a real database.
  Worth remembering if you add a new cross-module service dependency:
  `tsc` passing is not proof the app will boot; only `npm run start:dev`
  actually proves that.
- **Tests**: Jest + ts-jest configured. `RngService`, `evaluateWithdrawalRisk`,
  and the pure `isWinningSelection`/`computeGiftSplit` functions have real,
  currently-passing unit tests with no external dependencies — confirmed
  running in the environment this was built in, not just written.
  `WalletService` and `GiftService` have tests against an in-memory fake
  Prisma (`test-utils/fake-prisma.ts`); you've already run these
  successfully (26/26 passing as of the last update). Keep an eye on the
  fake when adding new Prisma calls to a tested service — it only stubs
  what's been used so far, and a call it doesn't implement fails with
  `TypeError: ... is not a function` rather than a useful assertion
  failure (this has happened twice already; see git history).

## Testing

```bash
npm test                                    # after prisma generate — runs everything
npx jest src/games/rng.service.spec.ts      # runs standalone right now, no Prisma needed
```

`isWinningSelection` (game settlement) and `computeGiftSplit` (revenue
split) are exported as pure functions specifically so the money-critical
logic has direct unit tests, not just indirect coverage through the full
service.

## What's deliberately NOT here yet

- **Risk/fraud engine**: withdrawal review uses one placeholder constant
  (an amount threshold). Spec §54's real inputs (account age, KYC status,
  chargebacks, gift patterns, velocity, device/IP signals) aren't built.
- **KYC**: creator applications and withdrawals reference where KYC would
  gate, but no verification integration exists.
- **Agency settlement math**: recruiting/managing creators works; computing
  and crediting the agency's commission from ledger entries does not — see
  the comment in `agencies.service.ts` for why this needs a product decision
  (settlement cadence) before it's worth building.
- **Seat-request/approval queue**: built. PRIVATE and INVITE_ONLY rooms now
  go through a `SeatRequest` (PENDING→APPROVED/REJECTED) instead of
  immediate-join, and FOLLOWERS_ONLY rooms check the actual follow
  relationship instead of behaving like PUBLIC. One honest simplification:
  INVITE_ONLY doesn't yet block an uninvited user from creating a request
  the same way PRIVATE allows — see the comment in
  `RoomsService.requestSeat` for why (no invite-list concept to check
  against without `inviteToSeat` having been called first).
- **Full discovery/ranking engine**: `feed.discover()` (and `feed.forYou()`,
  which is deliberately the same thing right now) is follower-count only,
  explicitly a placeholder — see `feed.service.ts`.
- **Job failure handling**: a scheduled job that fires when a battle/round
  is already in an unexpected state (e.g. it was manually transitioned via
  the REST endpoint in the meantime) throws and gets logged as a failed
  BullMQ job rather than silently no-op'ing. Functionally harmless (the
  underlying methods are idempotent) but noisy — worth tightening before
  this runs unattended in production.

## Setup

```bash
npm install
cp .env.example .env    # then fill in real secrets and DATABASE_URL
npx prisma generate
npx prisma migrate dev --name init
npx ts-node prisma/seed.ts
npm run start:dev
```

Requires a running PostgreSQL instance matching `DATABASE_URL`.

## Trying the foundation

```bash
# Register
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"SuperSecret123","countryCode":"NG"}'

# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"SuperSecret123"}'

# Authenticated request
curl http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer <accessToken>"
```

## Trying the new phases

```bash
# Send a gift (after buying coins and having a recipient)
curl -X POST http://localhost:3000/api/v1/gifts/send \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"recipientId":"<userId>","giftId":"<giftId>","idempotencyKey":"unique-key-1"}'

# Create a Lucky Number round (GAME_OPERATOR/SUPER_ADMIN only, and only
# after flipping GameDefinition.status to ACTIVE + RegionalConfig.gamesEnabled
# + GameRegionConfig.enabled for the target country — all three gates)
curl -X POST http://localhost:3000/api/v1/admin/games/rounds \
  -H "Authorization: Bearer <admin-token>" -H "Content-Type: application/json" \
  -d '{"gameCode":"LUCKY_NUMBER","rulesVersion":1,"numberRange":30,"selectionCount":1,"entryPrice":10,"openAt":"2026-09-10T10:00:00Z","lockAt":"2026-09-10T10:05:00Z"}'
```

## Next steps (Phase 8 — Global rollout)

This is ongoing rather than a discrete phase — see the roadmap doc. The
regional-config schema decision from Phase 0 is already in place; what's
left is adding more countries/currencies/languages as they're cleared, plus
the AI live-translation differentiator (post-MVP).
