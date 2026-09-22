import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction, notConfigured } from '../common/provider-mode';

export interface Bank {
  code: string;
  name: string;
}

export interface ResolvedAccount {
  accountName: string;
}

export interface BankProvider {
  readonly id: string; // 'PAYSTACK'
  listBanks(countryCode: string): Promise<Bank[]>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount>;
  // Registers the destination with the provider. The provider keeps the full
  // account number; only the returned recipient code is stored on our side.
  createRecipient(input: { accountName: string; bankCode: string; accountNumber: string; currencyCode: string }): Promise<{ recipientCode: string }>;
}

export const BANK_PROVIDER = 'BANK_PROVIDER';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const BANK_CACHE_MS = 6 * 60 * 60 * 1000;
export const PAYSTACK_COUNTRIES: Record<string, { name: string; currency: string }> = { NG: { name: 'nigeria', currency: 'NGN' } };

// Talks to Paystack's bank / transfer-recipient endpoints, written against their
// public documentation. NOT round-tripped against Paystack's live API from the
// environment this was built in (it cannot reach api.paystack.co): test with a
// real PAYSTACK_SECRET_KEY before relying on it.
@Injectable()
export class PaystackBankProvider implements BankProvider {
  readonly id = 'PAYSTACK';
  private readonly logger = new Logger(PaystackBankProvider.name);
  private readonly cache = new Map<string, { at: number; banks: Bank[] }>();

  constructor(private readonly config: ConfigService) {}

  private get key(): string {
    const key = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured');
    return key;
  }

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
    } catch (e: any) {
      this.logger.warn(`Paystack request failed: ${e?.message ?? e}`);
      throw new BadGatewayException('Could not reach the payment provider. Please try again.');
    }
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.status === false) {
      const message = String(body?.message ?? `HTTP ${res.status}`);
      this.logger.warn(`Paystack ${path} rejected: ${message}`);
      // Paystack's own message for a bad account is user-safe ("Could not resolve account name…")
      if (res.status === 422 || res.status === 400) throw new BadRequestException(message);
      throw new BadGatewayException('The payment provider could not complete that request.');
    }
    return body.data;
  }

  async listBanks(countryCode: string): Promise<Bank[]> {
    const country = PAYSTACK_COUNTRIES[countryCode.toUpperCase()];
    if (!country) throw new BadRequestException('Bank payouts are not available in your country yet');
    const hit = this.cache.get(country.name);
    if (hit && Date.now() - hit.at < BANK_CACHE_MS) return hit.banks;
    const data: any[] = await this.call(`/bank?country=${country.name}&currency=${country.currency}&perPage=200&use_cursor=false`);
    const banks = (Array.isArray(data) ? data : [])
      .filter((b) => b && b.active !== false && b.code && b.name)
      .map((b) => ({ code: String(b.code), name: String(b.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.cache.set(country.name, { at: Date.now(), banks });
    return banks;
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount> {
    const data = await this.call(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    if (!data?.account_name) throw new BadRequestException('Could not verify that account');
    return { accountName: String(data.account_name) };
  }

  async createRecipient(input: { accountName: string; bankCode: string; accountNumber: string; currencyCode: string }) {
    const data = await this.call('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({ type: 'nuban', name: input.accountName, account_number: input.accountNumber, bank_code: input.bankCode, currency: input.currencyCode }),
    });
    if (!data?.recipient_code) throw new BadGatewayException('The payment provider did not return a recipient');
    return { recipientCode: String(data.recipient_code) };
  }
}

// Development only. Invents a bank list and a fixed account name so the app's
// flow can be exercised without a Paystack key. Never used in production.
export class MockBankProvider implements BankProvider {
  readonly id = 'PAYSTACK';
  async listBanks(): Promise<Bank[]> {
    return [
      { code: '044', name: 'Access Bank (test)' },
      { code: '058', name: 'Guaranty Trust Bank (test)' },
      { code: '057', name: 'Zenith Bank (test)' },
    ];
  }
  async resolveAccount(): Promise<ResolvedAccount> {
    return { accountName: 'TEST ACCOUNT HOLDER' };
  }
  async createRecipient(input: { accountNumber: string }) {
    return { recipientCode: `RCP_mock_${input.accountNumber.slice(-4)}` };
  }
}

export class UnavailableBankProvider implements BankProvider {
  readonly id = 'PAYSTACK';
  private fail(): never {
    return notConfigured('Bank payouts', 'set PAYSTACK_SECRET_KEY');
  }
  async listBanks(): Promise<never> {
    return this.fail();
  }
  async resolveAccount(): Promise<never> {
    return this.fail();
  }
  async createRecipient(): Promise<never> {
    return this.fail();
  }
}

export function chooseBankProvider(config: ConfigService): BankProvider {
  if (config.get<string>('PAYSTACK_SECRET_KEY')) return new PaystackBankProvider(config);
  return isProduction(config.get<string>('NODE_ENV')) ? new UnavailableBankProvider() : new MockBankProvider();
}
