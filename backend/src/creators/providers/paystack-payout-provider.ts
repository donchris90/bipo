import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { verifyPaystackSignature } from '../../economy/providers/paystack-signature';
import type { PayoutProvider } from './payout-provider.interface';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// Paystack references must be 16-50 chars of lowercase letters, digits, - and _.
// Ours (a UUID, possibly client-supplied) is normalised to that.
export function toPaystackReference(idempotencyKey: string): string {
  // Do not truncate the raw key: two long client keys could otherwise collide
  // after the 50-character Paystack limit and become the same transfer. A
  // stable digest gives us a compact, deterministic reference with the same
  // idempotency identity every time.
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `wd_${digest.slice(0, 47)}`;
}

// Sends money with Paystack Transfers, written against Paystack's public
// documentation and NOT round-tripped against their live API from where this was
// built (it cannot reach api.paystack.co): test with a real key, small amounts,
// before trusting it with real money.
//
// Operational requirements on your Paystack account:
//  - a balance funded to cover payouts (transfers draw on it);
//  - "Confirm transfers before sending" (the OTP requirement) turned OFF in the
//    dashboard, or every transfer will stop at `otp` and be treated as failed;
//  - the webhook URL  https://<your-api>/api/v1/webhooks/payouts  set in the
//    dashboard, so results (paid / failed / reversed) reach the backend.
@Injectable()
export class PaystackPayoutProvider implements PayoutProvider {
  private readonly logger = new Logger(PaystackPayoutProvider.name);
  readonly isConfigured = true;

  constructor(private readonly config: ConfigService) {}

  private get key(): string {
    const key = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured');
    return key;
  }

  async initiatePayout(params: { userId: string; amountMinor: number; currencyCode: string; idempotencyKey: string; recipientCode?: string }) {
    if (!params.recipientCode) throw new Error('No payout account (recipient) to pay');
    const res = await fetch(`${PAYSTACK_BASE_URL}/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'balance',
        amount: params.amountMinor,
        currency: params.currencyCode,
        recipient: params.recipientCode,
        reason: 'RRYDA creator payout',
        reference: toPaystackReference(params.idempotencyKey),
      }),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.status === false) throw new Error(`Paystack transfer rejected: ${body?.message ?? res.status}`);

    const data = body?.data;
    if (data?.status === 'otp') {
      // Would need a manual OTP to finalise. Treated as a failure (the caller
      // releases the coins) rather than leaving money in limbo.
      throw new Error('Paystack requires OTP confirmation for transfers — turn that off in the Paystack dashboard');
    }
    if (!data?.transfer_code) throw new Error('Paystack did not return a transfer code');
    return { providerRef: String(data.transfer_code) };
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const sig = headers['x-paystack-signature'];
    return verifyPaystackSignature(rawBody, Array.isArray(sig) ? sig[0] : sig, this.key);
  }

  parseWebhook(payload: any) {
    const event = payload?.event;
    const ref = payload?.data?.transfer_code;
    if (!ref) return null;
    if (event === 'transfer.success') return { providerRef: String(ref), status: 'paid' as const };
    if (event === 'transfer.failed') return { providerRef: String(ref), status: 'failed' as const, reason: String(payload?.data?.reason ?? 'The transfer failed') };
    if (event === 'transfer.reversed') return { providerRef: String(ref), status: 'reversed' as const, reason: 'The transfer was reversed' };
    return null;
  }

  async handleWebhook(payload: any) {
    const parsed = this.parseWebhook(payload);
    if (!parsed) throw new Error('Not a payout event');
    return parsed;
  }
}
