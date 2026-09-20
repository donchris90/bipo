// The invariant this checks: for every wallet, the sum of its LedgerEntry
// amounts must equal its current balance. If they ever diverge, something
// bypassed WalletService (which shouldn't be possible — see the comment at
// the top of wallet.service.ts) or a migration/manual DB edit touched
// balances directly. Either way, this is the tripwire that catches it.
export interface WalletReconciliation {
  walletId: string;
  ledgerSum: bigint;
  walletBalance: bigint;
  discrepancy: bigint; // walletBalance - ledgerSum; zero means reconciled
  ok: boolean;
}

export function reconcileWallet(walletId: string, walletBalance: bigint, ledgerSum: bigint): WalletReconciliation {
  const discrepancy = walletBalance - ledgerSum;
  return { walletId, ledgerSum, walletBalance, discrepancy, ok: discrepancy === 0n };
}
