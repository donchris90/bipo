import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { verifyPaystackSignature } from './paystack-signature';
import type { PaymentProvider, CreatePaymentResult, VerifyPaymentResult } from './payment-provider.interface';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// NOT verified against Paystack's live API in this environment — the
// sandbox this was built in cannot reach api.paystack.co at all (only a
// short domain allowlist for package registries). Every call here is
// written against Paystack's public API documentation, but has not
// actually round-tripped against their servers. Test with real
// PAYSTACK_SECRET_KEY / webhook events before trusting this with real
// money.
@Injectable()
export class PaystackPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(PaystackPaymentProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get secretKey(): string {
    const key = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured');
    return key;
  }

  async createPayment(params: {
    amountMinor: number;
    currencyCode: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<CreatePaymentResult> {
    // Paystack requires a customer email to initialize a transaction —
    // looked up here rather than added to the shared PaymentProvider
    // interface, since that's a Paystack-specific requirement, not a
    // universal one every provider needs.
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: params.userId } });

    // Paystack's "reference" is caller-chosen and must be unique per
    // transaction — reusing our own idempotencyKey directly means there's
    // only ever one identifier to reconcile, not two independent ones that
    // could drift apart.
    const reference = params.idempotencyKey;

    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        amount: params.amountMinor, // Paystack wants the amount in the currency's minor unit (kobo for NGN) — matches this codebase's own minor-unit convention already, see config/currency.util.ts
        currency: params.currencyCode,
        reference,
      }),
    });

    const body = await response.json();
    if (!response.ok || !body.status) {
      this.logger.error(`Paystack initialize failed: ${JSON.stringify(body)}`);
      throw new Error(`Paystack transaction initialization failed: ${body.message ?? 'unknown error'}`);
    }

    return {
      providerRef: reference,
      redirectUrl: body.data.authorization_url,
    };
  }

  // Called from CoinPurchaseService.confirm() — itself only ever called
  // from the signature-verified webhook handler below, never directly from
  // a client request. This double-checks with Paystack's own API rather
  // than trusting the webhook payload's claimed status, belt-and-suspenders
  // against a webhook that was replayed or arrived with a stale status.
  async verifyPayment(providerRef: string): Promise<VerifyPaymentResult> {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });

    const body = await response.json();
    if (!response.ok || !body.status) {
      return { verified: false, amountMinor: 0, currencyCode: '' };
    }

    return {
      verified: body.data.status === 'success',
      amountMinor: body.data.amount,
      currencyCode: body.data.currency,
    };
  }

  async refundPayment(providerRef: string): Promise<{ refunded: boolean }> {
    const response = await fetch(`${PAYSTACK_BASE_URL}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction: providerRef }),
    });
    const body = await response.json();
    return { refunded: response.ok && body.status === true };
  }

  // The webhook controller passes the raw body + full headers here rather
  // than doing verification itself, so the "which header, which algorithm"
  // knowledge stays inside the provider that knows the scheme — a
  // different provider would verify completely differently.
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const signatureHeader = headers['x-paystack-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    return verifyPaystackSignature(rawBody, signature, this.secretKey);
  }

  async handleWebhook(payload: any): Promise<{ providerRef: string; status: 'confirmed' | 'failed' }> {
    // Paystack's event types: charge.success is the one that matters for
    // coin purchases. Others (transfer.success, refund.processed, etc.)
    // exist but aren't handled here — this method is only ever reached
    // after the caller has already verified the signature and decided
    // this looks like a purchase-confirmation event.
    const reference = payload?.data?.reference;
    const status = payload?.event === 'charge.success' ? 'confirmed' : 'failed';
    return { providerRef: reference, status };
  }
}
