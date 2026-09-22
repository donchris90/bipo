import { BadRequestException } from '@nestjs/common';
import { MockBankProvider, PaystackBankProvider, UnavailableBankProvider, chooseBankProvider } from './bank-provider';

const cfg = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as any;

describe('chooseBankProvider', () => {
  it('uses Paystack when a key is set', () => {
    expect(chooseBankProvider(cfg({ PAYSTACK_SECRET_KEY: 'sk' }))).toBeInstanceOf(PaystackBankProvider);
  });
  it('uses the test stand-in in development without a key', () => {
    expect(chooseBankProvider(cfg({ NODE_ENV: 'development' }))).toBeInstanceOf(MockBankProvider);
  });
  it('NEVER uses the stand-in in production: no key means unavailable', async () => {
    const p = chooseBankProvider(cfg({ NODE_ENV: 'production' }));
    expect(p).toBeInstanceOf(UnavailableBankProvider);
    await expect(p.resolveAccount('058', '0123456789')).rejects.toThrow(/not configured/);
  });
});

describe('PaystackBankProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const provider = () => new PaystackBankProvider(cfg({ PAYSTACK_SECRET_KEY: 'sk' }));

  it('lists banks, drops inactive ones, sorts, and caches', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ status: true, data: [{ name: 'Zenith', code: '057' }, { name: 'Access', code: '044' }, { name: 'Old', code: '000', active: false }] }) });
    global.fetch = fetchMock as any;
    const p = provider();
    expect((await p.listBanks('NG')).map((b) => b.name)).toEqual(['Access', 'Zenith']);
    await p.listBanks('NG');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only supports countries it is set up for', async () => {
    await expect(provider().listBanks('GH')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes Paystack\'s "could not resolve account" message to the user as a 400', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ status: false, message: 'Could not resolve account name.' }) }) as any;
    await expect(provider().resolveAccount('058', '0123456789')).rejects.toThrow('Could not resolve account name.');
  });
});
