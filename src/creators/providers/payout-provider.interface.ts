import { notConfigured } from '../../common/provider-mode';

export interface PayoutProvider {
  // False when no real payout provider is wired in (see UnavailablePayoutProvider).
  // Checked BEFORE any money is reserved, so a withdrawal that cannot be paid out
  // is refused up front rather than reserved, failed and released.
  readonly isConfigured?: boolean;

  // `amountMinor` is the CASH to send, in the currency's minor unit (the net
  // amount after fees) — not coins. `recipientCode` identifies the saved
  // payout account at the provider.
  initiatePayout(params: {
    userId: string;
    amountMinor: number;
    currencyCode: string;
    idempotencyKey: string;
    recipientCode?: string;
  }): Promise<{ providerRef: string }>;

  // Providers that deliver results by webhook must prove the request is really
  // theirs. A provider without this cannot receive webhooks at all: the webhook
  // route refuses rather than trusting an unverifiable payload.
  verifyWebhookSignature?(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;

  // Reads a webhook body into a payout result, or null for an event that is not
  // about a payout outcome.
  parseWebhook?(payload: any): { providerRef: string; status: 'paid' | 'failed'; reason?: string } | null;

  // Real implementations report status asynchronously via webhook, not a
  // synchronous return — this mock simplifies to immediate success for
  // local development only.
  handleWebhook(payload: unknown): Promise<{ providerRef: string; status: 'paid' | 'failed'; reason?: string }>;
}

// Used when no real payout provider is configured (no PAYSTACK_SECRET_KEY) in
// production: withdrawals are refused with a 503 rather than pretending money
// was sent.
export class UnavailablePayoutProvider implements PayoutProvider {
  readonly isConfigured = false;
  async initiatePayout(): Promise<never> {
    return notConfigured('Payouts', 'set PAYSTACK_SECRET_KEY');
  }
  async handleWebhook(): Promise<never> {
    return notConfigured('Payouts', 'set PAYSTACK_SECRET_KEY');
  }
}

export class MockPayoutProvider implements PayoutProvider {
  async initiatePayout(params: { idempotencyKey: string }) {
    return { providerRef: `mockpayout_${params.idempotencyKey}` };
  }

  async handleWebhook(payload: any) {
    return { providerRef: payload?.providerRef ?? 'unknown', status: 'paid' as const };
  }
}
