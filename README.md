# Economy #10 — C2C worked files

Fixed atomic C2C order state transitions:
- Payment submission can only move ACCEPTED -> PAYMENT_SUBMITTED atomically.
- Disputes can only claim ACCEPTED/PAYMENT_SUBMITTED atomically.
- Admin dispute resolution must claim DISPUTED before crediting either side.

This prevents concurrent cancel/release/dispute/resolve operations from creating double-settlement paths.
