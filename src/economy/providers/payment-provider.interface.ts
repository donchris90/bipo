import { notConfigured } from '../../common/provider-mode';

// interface PaymentProvider from spec §28. Swap MockPaymentProvider for a
// real one (Paystack, Flutterwave, Stripe, Apple/Google IAP) per country
// without touching wallet/ledger logic — nothing outside this file should
// know which provider is in use.
export interface CreatePaymentResult {
  providerRef: string;
  redirectUrl?: string; // for hosted checkout flows
}

export interface VerifyPaymentResult {
  verified: boolean;
  amountMinor: number;
  currencyCode: string;
}

export interface PaymentProvider {
  createPayment(params: {
    amountMinor: number;
    currencyCode: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<CreatePaymentResult>;

  verifyPayment(providerRef: string): Promise<VerifyPaymentResult>;

  refundPayment(providerRef: string): Promise<{ refunded: boolean }>;

  // Optional because MockPaymentProvider has no real signature scheme to
  // check. Real providers MUST implement this — the webhook controller
  // calls it when present and rejects the request outright when it's
  // missing on whatever provider is currently wired in, rather than
  // silently skipping verification. Takes the full headers object (not a
  // single pre-extracted header) so provider-specific knowledge — which
  // header name matters, Paystack's is `x-paystack-signature`, other
  // providers use something else entirely — stays inside the provider,
  // not leaked into the controller calling this.
  verifyWebhookSignature?(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;

  // Returns a normalized event the caller can act on. Only ever called
  // after verifyWebhookSignature (when the provider has one) has already
  // passed — a forged webhook is a direct path to "trust client-reported
  // payment success", which spec §26/§94 explicitly forbid.
  handleWebhook(payload: unknown, signature?: string): Promise<{ providerRef: string; status: 'confirmed' | 'failed' }>;
}

// Used in production when no payment provider is configured. Every call fails
// loudly (503) rather than pretending a payment succeeded.
export class UnavailablePaymentProvider implements PaymentProvider {
  private fail(): never {
    return notConfigured('Payments', 'set PAYSTACK_SECRET_KEY');
  }
  async createPayment(): Promise<CreatePaymentResult> {
    return this.fail();
  }
  async verifyPayment(): Promise<VerifyPaymentResult> {
    return this.fail();
  }
  async refundPayment(): Promise<{ refunded: boolean }> {
    return this.fail();
  }
  async handleWebhook(): Promise<{ providerRef: string; status: 'confirmed' | 'failed' }> {
    return this.fail();
  }
}

export class MockPaymentProvider implements PaymentProvider {
  async createPayment(params: { amountMinor: number; currencyCode: string; userId: string; idempotencyKey: string }) {
    return { providerRef: `mock_${params.idempotencyKey}` };
  }

  async verifyPayment(providerRef: string): Promise<VerifyPaymentResult> {
    // Dev-only stand-in: always reports success. Replace before touching
    // real money — this exists so the coin-purchase flow is exercisable
    // end-to-end without a live payment provider account.
    return { verified: true, amountMinor: 0, currencyCode: 'NGN' };
  }

  async refundPayment(providerRef: string) {
    return { refunded: true };
  }

  // Dev-only stand-in: always "verifies" successfully, providing NO real
  // security — consistent with verifyPayment() above, which also always
  // reports success. This was originally left unimplemented on the theory
  // that a rejected mock webhook was "the thing to look at, not a bug to
  // route around" — that was wrong in practice: it silently blocked the
  // entire mock purchase flow from being testable at all, which defeats
  // the actual purpose of having a mock provider. The real protection
  // against a forged webhook is that this code path is only ever reached
  // when MockPaymentProvider is active in the first place (no
  // PAYSTACK_SECRET_KEY configured) — never wire this in anywhere real
  // payments matter.
  verifyWebhookSignature(): boolean {
    return true;
  }

  async handleWebhook(payload: any) {
    return { providerRef: payload?.providerRef ?? 'unknown', status: 'confirmed' as const };
  }
}
