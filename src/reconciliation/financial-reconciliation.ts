export type FinancialIssueCategory = 'GIFT' | 'COIN_PURCHASE' | 'CHARGEBACK' | 'WITHDRAWAL';

export interface ExpectedLedgerMovement {
  key: string;
  amount: bigint;
}

export interface FinancialReconciliationIssue {
  category: FinancialIssueCategory;
  reference: string;
  missingLedgerKeys: string[];
  mismatchedLedgerEntries: Array<{ key: string; expectedAmount: string; actualAmount: string }>;
  reason: string;
}

export interface FinancialReconciliationResult {
  checked: {
    gifts: number;
    coinPurchases: number;
    chargebacks: number;
    withdrawals: number;
  };
  issueCount: number;
  issues: FinancialReconciliationIssue[];
  legacySnapshotWarnings: number;
  truncated: boolean;
}

export function buildExpectedLedgerMovements(row: any): ExpectedLedgerMovement[] {
  if (row.category === 'GIFT') {
    const tx = row.data;
    const keys: ExpectedLedgerMovement[] = [{ key: `gift_sent:${tx.idempotencyKey}`, amount: -BigInt(tx.coinAmount ?? 0) }];
    if (Number(tx.creatorShareCoins ?? 0) > 0) keys.push({ key: `gift_received:${tx.idempotencyKey}`, amount: BigInt(tx.creatorShareCoins) });
    if (Number(tx.platformShareCoins ?? 0) > 0) keys.push({ key: `gift_platform:${tx.idempotencyKey}`, amount: BigInt(tx.platformShareCoins) });
    if (Number(tx.agencyShareCoins ?? 0) > 0) keys.push({ key: `gift_agency:${tx.idempotencyKey}`, amount: BigInt(tx.agencyShareCoins) });
    if (Number(tx.luckyRewardCoins ?? 0) > 0) {
      keys.push({ key: `gift_lucky_bonus:${tx.idempotencyKey}`, amount: BigInt(tx.luckyRewardCoins) });
      keys.push({ key: `gift_lucky_platform:${tx.idempotencyKey}`, amount: -BigInt(tx.luckyRewardCoins) });
    }
    return keys;
  }

  if (row.category === 'COIN_PURCHASE') {
    return row.data.status === 'CONFIRMED' || row.data.status === 'CHARGEBACK'
      ? [{ key: `coin_purchase:${row.data.id}`, amount: BigInt(row.data.coinAmount ?? 0) }]
      : [];
  }

  if (row.category === 'CHARGEBACK') {
    return row.data.coinPurchaseId
      ? [{ key: `chargeback:${row.data.coinPurchaseId}`, amount: -BigInt(row.data.coinAmount ?? 0) }]
      : [];
  }

  if (row.category === 'WITHDRAWAL') {
    const keys: ExpectedLedgerMovement[] = [{ key: `withdrawal_reserve:${row.data.idempotencyKey}`, amount: -BigInt(row.data.amountMinor ?? 0) }];
    if (['FAILED', 'REJECTED', 'REVERSED'].includes(row.data.status)) {
      keys.push({ key: `withdrawal_release:${row.data.idempotencyKey}`, amount: BigInt(row.data.amountMinor ?? 0) });
    }
    return keys;
  }

  return [];
}

export function buildExpectedLedgerKeys(row: any): string[] {
  return buildExpectedLedgerMovements(row).map((movement) => movement.key);
}
