# Production smoke tests for items 1, 3, 4 and 5

These require a deployed backend with real sandbox credentials; source-only validation cannot prove provider/network behaviour.

## 1. Financial
1. Create a Paystack coin purchase; complete it in sandbox; verify webhook is accepted and wallet increases once.
2. Replay the exact webhook; wallet must not increase again.
3. Send a valid webhook with a mismatched amount/currency; purchase must become FAILED and no coins are credited.
4. Exercise payout initiation, success, failure, reversal and duplicate webhook events.
5. Run two concurrent wallet debits against the same balance and verify no negative balance or double settlement.
6. Run scheduled reconciliation and confirm discrepancy audit records are created.

## 3. C2C
1. Buyer creates an order using a configured regional C2C rate.
2. KYC-verified seller accepts; seller coin balance decreases by the escrow amount exactly once.
3. Buyer submits payment reference/proof.
4. Seller releases; buyer receives the exact coin amount exactly once.
5. Replay release/cancel requests; no duplicate credit.
6. Let an accepted order expire; seller escrow must refund exactly once.
7. Open a dispute and resolve both RELEASE and REFUND paths as Finance Admin.

## 4. Crypto
1. Configure NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, NOWPAYMENTS_PRICE_CURRENCY, NOWPAYMENTS_PAY_CURRENCY and callback URL.
2. Start a CRYPTO purchase; verify the returned hosted checkout URL.
3. Complete the provider sandbox payment and verify signed IPN.
4. Replay the IPN; no duplicate credit.
5. Test failed/expired/refunded provider events.
6. Test amount/currency mismatch; no credit.

## 5. Infrastructure
1. `/api/v1/health/ready` must report database, Redis and production storage as `ok`.
2. Stop Redis and confirm the API remains available for DB-backed recovery paths; queue errors must be logged.
3. Fill Redis memory close to the configured maxmemory and verify jobs retry rather than hanging indefinitely.
4. Force a job failure through all retry attempts and verify a record appears in `platform-dead-letter`.
5. Upload a real video to S3/R2, publish it, play it with HTTP Range, delete it, then test CDN cache behaviour.
6. Load-test WebSocket, PostgreSQL, Redis, Agora and FFmpeg separately before production traffic.
