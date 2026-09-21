

## v8 money-state integrity fixes
- Withdrawal provider webhooks now use guarded PROCESSING -> PAID/FAILED transitions; late conflicting webhooks cannot resurrect/refund a terminal payout.
- Withdrawal reserve release occurs only when the PROCESSING -> FAILED transition is won.
- Coin purchase terminal failure updates are guarded to avoid overwriting a concurrent CONFIRMED state.
- Provider references are unique at the database layer for purchases and withdrawals.

- Added explicit `REVERSED` withdrawal state for Paystack transfers that succeed and are later reversed; reversal restores the reserved coins exactly once.
