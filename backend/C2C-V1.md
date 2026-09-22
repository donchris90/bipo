# C2C V1

Implemented a server-authoritative C2C coin marketplace.

Flow: buyer creates order -> seller accepts and coins are atomically escrowed -> buyer submits payment proof/reference -> seller releases -> buyer receives coins.

Cancellation/expiry refunds escrowed seller coins. Disputes freeze settlement and can be resolved by SUPER_ADMIN or FINANCE_ADMIN. Every wallet movement uses the existing idempotent WalletService and every admin resolution is audited.

Important: payment proof/reference is evidence only. This V1 does NOT falsely mark an off-platform fiat payment as verified. Production C2C should add a verified payment provider/escrow integration before allowing automated release.
