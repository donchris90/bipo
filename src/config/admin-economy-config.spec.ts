import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RegionalConfigService } from './regional-config.service';
import { CoinPackageAdminService } from '../economy/coin-package-admin.service';

function regional() {
  const rows = new Map<string, any>();
  const prisma: any = {
    regionalConfig: {
      findUnique: async ({ where: { countryCode } }: any) => rows.get(countryCode) ?? null,
      upsert: async ({ where: { countryCode }, update, create }: any) => { const row = rows.has(countryCode) ? Object.assign(rows.get(countryCode), update) : { ...create }; rows.set(countryCode, row); return row; },
    },
  };
  const audit: any = { record: jest.fn() };
  return { svc: new RegionalConfigService(prisma, audit), audit, rows };
}
const NG = { countryCode: 'ng', countryName: 'Nigeria', currencyCode: 'NGN', defaultLanguage: 'en' };

describe('country / economy configuration (admin)', () => {
  it('saves a country, normalises the code, keeps only the payment methods that exist, and audits it', async () => {
    const { svc, audit } = regional();
    const saved: any = await svc.upsert({ ...NG, gamesEnabled: true, paymentMethods: ['paystack', 'CRYPTO', 'bitcoin', 'paystack'] }, 'admin1', ['SUPER_ADMIN'] as any);
    expect(saved).toMatchObject({ countryCode: 'NG', paymentMethods: ['PAYSTACK', 'CRYPTO'] });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin1', action: 'regional_config.upsert', targetId: 'NG' }));
  });

  it('rejects bad economy numbers: negative or fractional creator rate / coin value, and a non-positive C2C rate', async () => {
    const { svc, rows } = regional();
    await expect(svc.upsert({ ...NG, creatorEarningMinorPer100Coins: -1 }, 'a', [] as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upsert({ ...NG, creatorEarningMinorPer100Coins: 1.5 }, 'a', [] as any)).rejects.toThrow(/non-negative whole number/);
    await expect(svc.upsert({ ...NG, coinUsdCentsPer100: -3 }, 'a', [] as any)).rejects.toThrow(/coinUsdCentsPer100/);
    await expect(svc.upsert({ ...NG, c2cFiatMinorPer100Coins: 0 }, 'a', [] as any)).rejects.toThrow(/positive whole number/);
    expect(rows.size).toBe(0); // nothing saved
  });

  it('a country only counts as games-enabled when it is BOTH active and has games on', async () => {
    const { svc } = regional();
    await svc.upsert({ ...NG, active: true, gamesEnabled: true }, 'a', [] as any);
    expect(await svc.isGamesEnabled('NG')).toBe(true);
    await svc.upsert({ ...NG, active: false, gamesEnabled: true }, 'a', [] as any);
    expect(await svc.isGamesEnabled('ng')).toBe(false);
    await svc.upsert({ ...NG, active: true, gamesEnabled: false }, 'a', [] as any);
    expect(await svc.isGamesEnabled('NG')).toBe(false);
    expect(await svc.isGamesEnabled('ZZ')).toBe(false);
  });

  it.failing('DEFECT: nothing checks the currency code, country name or minimum age an admin types in (e.g. "XX", an empty name, age 0)', async () => {
    const { svc } = regional();
    await expect(svc.upsert({ countryCode: 'NG', countryName: '', currencyCode: 'naira!', defaultLanguage: 'en', minAge: 0 } as any, 'a', [] as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

function packages() {
  const regions = new Map<string, any>([['NG', { countryCode: 'NG', currencyCode: 'NGN' }]]);
  const pkgs = new Map<string, any>();
  let n = 0;
  const prisma: any = {
    regionalConfig: { findUnique: async ({ where: { countryCode } }: any) => regions.get(countryCode) ?? null },
    coinPackage: {
      findUnique: async ({ where: { id } }: any) => (pkgs.has(id) ? { ...pkgs.get(id) } : null), // a copy, like a real read
      findMany: async () => [...pkgs.values()],
      create: async ({ data }: any) => { const row = { id: `p${++n}`, ...data }; pkgs.set(row.id, row); return row; },
      update: async ({ where: { id }, data }: any) => Object.assign(pkgs.get(id), data),
    },
  };
  const audit: any = { record: jest.fn() };
  return { svc: new CoinPackageAdminService(prisma, audit), audit, pkgs };
}

describe('coin packages (admin)', () => {
  it("creates a package in the country's own currency (the admin cannot pick a different one) and audits it", async () => {
    const { svc, audit } = packages();
    const saved: any = await svc.upsert(undefined, { countryCode: 'ng', coinAmount: 1000, priceMinor: 500000, currencyCode: 'USD' }, 'admin1', ['FINANCE_ADMIN'] as any);
    expect(saved).toMatchObject({ countryCode: 'NG', currencyCode: 'NGN', coinAmount: 1000, priceMinor: 500000, active: true });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'coin_package.create', actorId: 'admin1' }));
  });

  it('refuses a bad country code, an unconfigured country, and coin amounts or prices that are not positive whole numbers', async () => {
    const { svc, pkgs } = packages();
    await expect(svc.upsert(undefined, { countryCode: 'NGA', coinAmount: 1, priceMinor: 1 }, 'a', [] as any)).rejects.toThrow(/ISO-2/);
    await expect(svc.upsert(undefined, { countryCode: 'GH', coinAmount: 1, priceMinor: 1 }, 'a', [] as any)).rejects.toBeInstanceOf(NotFoundException);
    for (const bad of [0, -5, 1.5, NaN]) {
      await expect(svc.upsert(undefined, { countryCode: 'NG', coinAmount: bad, priceMinor: 100 }, 'a', [] as any)).rejects.toThrow(/coinAmount/);
      await expect(svc.upsert(undefined, { countryCode: 'NG', coinAmount: 10, priceMinor: bad }, 'a', [] as any)).rejects.toThrow(/priceMinor/);
    }
    expect(pkgs.size).toBe(0);
  });

  it('editing records before and after; switching off and on records the change; an unknown package is 404', async () => {
    const { svc, audit } = packages();
    const p: any = await svc.upsert(undefined, { countryCode: 'NG', coinAmount: 1000, priceMinor: 500000 }, 'a', [] as any);
    const edited: any = await svc.upsert(p.id, { countryCode: 'NG', coinAmount: 1000, priceMinor: 450000 }, 'a', [] as any);
    expect(edited.priceMinor).toBe(450000);
    expect(audit.record.mock.calls.at(-1)[0].metadata.before.priceMinor).toBe(500000);
    const off: any = await svc.setActive(p.id, false, 'a', [] as any);
    expect(off.active).toBe(false);
    expect(audit.record.mock.calls.at(-1)[0]).toMatchObject({ action: 'coin_package.status' });
    await expect(svc.setActive('nope', true, 'a', [] as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});
