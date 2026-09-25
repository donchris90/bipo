import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import type { PaymentProvider, CreatePaymentResult, VerifyPaymentResult } from './payment-provider.interface';

const NOWPAYMENTS_BASE_URL = 'https://api.nowpayments.io/v1';

function sortObject(value: any): any {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out: any, key) => {
      out[key] = sortObject(value[key]);
      return out;
    }, {});
  }
  return value;
}

export function nowPaymentsSignature(rawBody: Buffer, secret: string): string {
  let parsed: any;
  try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { return ''; }
  return createHmac('sha512', secret).update(JSON.stringify(sortObject(parsed))).digest('hex');
}

@Injectable()
export class NowPaymentsPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(NowPaymentsPaymentProvider.name);
  readonly providerId = 'nowpayments';

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    const key = this.config.get<string>('NOWPAYMENTS_API_KEY');
    if (!key) throw new Error('NOWPAYMENTS_API_KEY is not configured');
    return key;
  }

  private get ipnSecret(): string {
    const key = this.config.get<string>('NOWPAYMENTS_IPN_SECRET');
    if (!key) throw new Error('NOWPAYMENTS_IPN_SECRET is not configured');
    return key;
  }

  private get priceCurrency(): string {
    return (this.config.get<string>('NOWPAYMENTS_PRICE_CURRENCY') ?? 'USD').toUpperCase();
  }

  private get payCurrency(): string {
    return (this.config.get<string>('NOWPAYMENTS_PAY_CURRENCY') ?? 'USDTTRC20').toLowerCase();
  }

  async createPayment(params: { amountMinor: number; currencyCode: string; userId: string; idempotencyKey: string }): Promise<CreatePaymentResult> {
    if (params.currencyCode.toUpperCase() !== this.priceCurrency) {
      throw new Error(`NOWPayments is configured for ${this.priceCurrency}, not ${params.currencyCode}`);
    }
    const priceAmount = params.amountMinor / 100;
    const response = await fetch(`${NOWPAYMENTS_BASE_URL}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: priceAmount,
        price_currency: this.priceCurrency.toLowerCase(),
        order_id: `coin:${params.idempotencyKey}`,
        order_description: `RYDA coin purchase for ${params.userId}`,
        pay_currency: this.payCurrency,
        ipn_callback_url: this.config.get<string>('NOWPAYMENTS_IPN_CALLBACK_URL'),
        success_url: this.config.get<string>('NOWPAYMENTS_SUCCESS_URL'),
        cancel_url: this.config.get<string>('NOWPAYMENTS_CANCEL_URL'),
      }),
    });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || body?.payment_status === 'failed' || body?.status === false) {
      this.logger.error(`NOWPayments invoice creation failed: ${JSON.stringify(body)}`);
      throw new Error(`NOWPayments payment initialization failed: ${body?.message ?? response.status}`);
    }
    const providerRef = String(body?.payment_id ?? body?.id ?? '');
    if (!providerRef) throw new Error('NOWPayments did not return a payment id');
    return { providerRef: `np_${providerRef}`, redirectUrl: body?.invoice_url ?? body?.payment_url };
  }

  async verifyPayment(providerRef: string): Promise<VerifyPaymentResult> {
    const id = providerRef.replace(/^np_/, '');
    const response = await fetch(`${NOWPAYMENTS_BASE_URL}/payment/${encodeURIComponent(id)}`, {
      headers: { 'x-api-key': this.apiKey },
    });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || !body) return { verified: false, amountMinor: 0, currencyCode: '' };
    const status = String(body.payment_status ?? 'unknown').toLowerCase();
    const price = Number(body.price_amount);
    return {
      verified: status === 'finished',
      amountMinor: Number.isFinite(price) ? Math.round(price * 100) : 0,
      currencyCode: String(body.price_currency ?? '').toUpperCase(),
    };
  }

  async refundPayment(): Promise<{ refunded: boolean }> {
    // NOWPayments refunds are operationally initiated through its refund flow;
    // do not pretend an API refund exists here. Chargeback/refund accounting
    // remains server-side and requires an explicit provider operation.
    return { refunded: false };
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const supplied = headers['x-nowpayments-sig'];
    const signature = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!signature) return false;
    const expected = nowPaymentsSignature(rawBody, this.ipnSecret);
    const a = Buffer.from(String(signature), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handleWebhook(payload: any) {
    const id = payload?.payment_id ?? payload?.id;
    if (!id) return { providerRef: '', status: 'ignored' as const };
    const status = String(payload?.payment_status ?? '').toLowerCase();
    if (status === 'finished') return { providerRef: `np_${id}`, status: 'confirmed' as const };
    if (['failed', 'expired', 'refunded'].includes(status)) return { providerRef: `np_${id}`, status: 'failed' as const };
    return { providerRef: `np_${id}`, status: 'ignored' as const };
  }
}
