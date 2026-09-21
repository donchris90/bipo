# RYDA V7 — Phases 4–10 Certification Pack

This pass hardens the existing Phase 3 payment/withdrawal implementation and adds a production certification checklist. It does **not** claim live-provider execution from this source tree alone. Real Paystack/NOWPayments credentials, a reachable deployment, a real database/Redis, and real Android devices are required for live certification.

## Phase 4 — Payments

- Paystack initialization: server creates the transaction and stores the provider reference + checkout URL.
- Paystack verification: coin credit requires provider-side verification of success, amount and currency.
- Webhook signature: raw-body HMAC verification is mandatory before payload handling.
- Duplicate webhook: purchase confirmation uses a stable wallet idempotency key and a terminal purchase state.
- Pending payment: status polling can safely refresh a pending provider transaction after a short grace period; non-terminal provider states remain pending.
- Failed/cancelled/reversed/expired: terminal provider states are mapped to `FAILED` without crediting coins.
- Chargebacks/refunds: Paystack dispute/refund events feed the existing atomic chargeback clawback path; repeated deliveries are idempotent.
- Coin credit: wallet credit and `CONFIRMED` purchase state commit in one database transaction.

## Phase 5 — Withdrawals

The backend already implements reserve → processing → paid/failed/reversed transitions, recipient verification, KYC/config/risk gates, manual review, idempotent provider calls and signed payout webhooks. Live certification must exercise each state with Paystack test/live accounts. Paystack currently documents `pending`, `success`, `reversed`, and `failed` transfer states, and account resolution before recipient creation.

## Phase 6 — Admin

Verify every admin route against role permissions and audit logging. Test both allowed and denied roles, including direct HTTP calls rather than relying on hidden UI buttons.

## Phase 7 — Games

Run concurrent entry, duplicate submission, payout, recovery and interrupted-connection tests against a real PostgreSQL instance. Verify the hidden Crash state is never exposed before settlement.

## Phase 8 — Social

Exercise private messages, live/party chat, read state, mute/block, follows, comments, likes, shares, PK invites/scoring/rewards, push delivery and reconnect behavior on at least two Android devices.

## Phase 9 — Security

Run a negative test suite for client-supplied coin amounts, recipients, country codes, creator earning rates, KYC flags, admin routes, C2C status, game results, replayed requests/webhooks and concurrent settlement. No client-supplied financial result should be authoritative.

## Phase 10 — Production certification

Three end-to-end actors must be exercised: User, Creator and Admin. Record request IDs, provider references, webhook deliveries, wallet balances and ledger entries for every money movement.

### Live prerequisites

```text
DATABASE_URL
REDIS_URL
PAYSTACK_SECRET_KEY
PAYSTACK webhook URL configured
Payout balance funded
Paystack transfer confirmation/OTP setting configured for API transfers
KYC provider or approved manual-review procedure
Real Android devices
Public HTTPS API endpoint
```

A passing automated test suite is not a substitute for live payment/provider certification.
