# Phase 10 — Launch Readiness

This phase adds a small operational safety layer rather than changing user balances or billing rules.

## Health endpoint

`GET /api/v1/health` performs a real database ping and returns `status`, database state, latency, and timestamp. A database failure returns HTTP 503 instead of falsely reporting healthy.

## Admin dashboard

The Admin dashboard now shows the live system health state and database latency.

## Verification checklist

Before production deployment:

1. Run `npm ci` in backend, mobile, and admin.
2. Run backend `npm run prisma:generate`.
3. Run backend `npm run typecheck` and `npm test`.
4. Run admin `npm test` and `npm run build`.
5. Run mobile `npm run lint`.
6. Apply Prisma migrations before starting the new backend build.
7. Verify `/api/v1/health` returns `status: ok` from the production API.
8. Verify Admin shows **Healthy** before opening creator earnings or 1-on-1 traffic.
9. Smoke-test: host level gating, 1-on-1 request/accept/end, billing idempotency, gift credit, withdrawal request, report/block, and notification delivery.
