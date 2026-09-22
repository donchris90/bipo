import { Injectable } from '@nestjs/common';
import type { PaymentProvider } from './payment-provider.interface';
import { PaystackPaymentProvider } from './paystack-payment-provider';
import { NowPaymentsPaymentProvider } from './nowpayments-payment-provider';

@Injectable()
export class PaymentProviderRouter implements PaymentProvider {
  constructor(
    private readonly paystack: PaystackPaymentProvider,
    private readonly crypto: NowPaymentsPaymentProvider,
  ) {}

  get cryptoConfigured(): boolean {
    try { return Boolean((this.crypto as any).apiKey); } catch { return false; }
  }

  private provider(methodOrRef?: string): PaymentProvider {
    if (methodOrRef === 'CRYPTO' || methodOrRef?.startsWith('np_')) return this.crypto;
    return this.paystack;
  }

  async createPayment(params: Parameters<PaymentProvider['createPayment']>[0] & { method?: string }) {
    return this.provider(params.method).createPayment(params);
  }

  async verifyPayment(providerRef: string) { return this.provider(providerRef).verifyPayment(providerRef); }
  async refundPayment(providerRef: string) { return this.provider(providerRef).refundPayment(providerRef); }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    try { if (this.paystack.verifyWebhookSignature(rawBody, headers)) return true; } catch {}
    try { if (this.crypto.verifyWebhookSignature(rawBody, headers)) return true; } catch {}
    return false;
  }

  async handleWebhook(payload: any) {
    if (payload?.event) return this.paystack.handleWebhook(payload);
    if (payload?.payment_status || payload?.payment_id) return this.crypto.handleWebhook(payload);
    return { providerRef: '', status: 'ignored' as const };
  }
}
