# Rryda financial + infrastructure readiness

## Payment rails
- Paystack and NOWPayments are selected server-side from the requested payment method and country configuration.
- Purchase confirmation still requires a verified provider webhook and an exact amount/currency match.
- Webhook events are hashed/idempotent; duplicate events do not double-credit a wallet.
- Live provider certification still requires real sandbox credentials and provider callbacks.

## C2C
- Regional C2C rate is server configured (`c2cFiatMinorPer100Coins`).
- Seller coins are debited into escrow at acceptance.
- Buyer submits payment evidence/reference; seller releases coins; disputes go to admin resolution.
- Cancellation/expiry refunds seller escrow exactly once.
- Admin resolution is audited.
- This remains a manual fiat settlement rail until a payment/escrow provider is integrated; do not market it as automated fiat escrow.

## Crypto
- NOWPayments is a real provider integration, not a mock.
- Configure API key, IPN secret, price currency, crypto pay currency, and callback URLs.
- Test invoice creation, IPN signature, finished/failed/expired events, duplicate callbacks, amount mismatch and provider downtime before production money flows.

## Queue/Redis
- PK, game and reconciliation jobs now use bounded exponential retries.
- Jobs that exhaust retries are copied to a dead-letter queue for investigation.
- Redis connection failures are logged and the game scheduler remains a PostgreSQL recovery path.
- Reconciliation remains scheduled through BullMQ.

## Storage
- Production without S3-compatible storage is fail-closed.
- S3/R2 self-check code is present; production certification still requires a real upload, range playback, delete and CDN/cache test.

## Still requires live-environment certification
- Paystack sandbox/live webhook round trips
- NOWPayments sandbox/live IPN round trips
- C2C two-account settlement and dispute scenarios
- concurrent wallet transactions/load tests
- Redis failover/maxmemory behaviour
- PostgreSQL/WebSocket/Agora/S3/FFmpeg load and failure tests
