import { PrismaClient, RoleName } from '@prisma/client';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { GLOBAL_COUNTRIES } from '../src/config/countries';

const prisma = new PrismaClient();

async function main() {
  // Starter regional configs — games/payments disabled by default until
  // Phase 0 legal review clears each country. Flip active/gamesEnabled
  // deliberately, never as a side effect of another change. NG is fully
  // active as the initial launch market; the rest are seeded inactive so
  // the schema/UI can be exercised against multiple countries without
  // implying they're actually live.
  const regions = GLOBAL_COUNTRIES.map((country) => ({
    ...country,
    // Nigeria is the initial launch market. Every other country exists in the
    // database from day one but stays inactive until an admin enables it.
    active: country.countryCode === 'NG',
    gamesEnabled: false,
    paymentsEnabled: country.countryCode === 'NG',
    paymentMethods: country.countryCode === 'NG' ? ['PAYSTACK', 'C2C'] : ['CRYPTO', 'C2C'],
  }));
  for (const region of regions) {
    await prisma.regionalConfig.upsert({
      where: { countryCode: region.countryCode },
      update: {
        countryName: region.countryName,
        currencyCode: region.currencyCode,
        defaultLanguage: region.defaultLanguage,
        active: region.active,
        paymentsEnabled: region.paymentsEnabled,
        gamesEnabled: region.gamesEnabled,
        paymentMethods: region.paymentMethods,
      },
      create: { ...region, minAge: 18 },
    });
  }

  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    // referralCode became a required, unique field after the referral
    // system was added — this seed script creates a User too, so it
    // needs one just like real registration does (see
    // AuthService.generateUniqueReferralCode's comment for why this is
    // a short hex code rather than a UUID). Collision retry not needed
    // here — the seed only ever creates the one admin row.
    const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    await prisma.user.create({
      data: {
        email,
        passwordHash,
        countryCode: 'NG',
        displayName: 'Super Admin',
        roles: { create: [{ role: RoleName.SUPER_ADMIN }] },
        referralCode,
      },
    });
    console.log(`Seeded super admin: ${email} / ${password} — change this password immediately.`);
  }

  // Global revenue split default — 70/30, matches spec §24's example but is
  // fully overridable per country via RevenueSplitConfig scope=COUNTRY.
  await prisma.revenueSplitConfig.upsert({
    where: { id: 'seed-global-split' },
    update: {},
    create: {
      id: 'seed-global-split',
      scope: 'GLOBAL',
      creatorShareBps: 7000,
      platformShareBps: 3000,
      agencyShareBps: 0,
    },
  });

  await prisma.pKScoreConfig.upsert({
    where: { id: 'seed-global-pk-score' },
    update: {},
    create: { id: 'seed-global-pk-score', countryCode: null, coinsPerPoint: 1 },
  });

  // Starter Nigeria package only; all additional country packages are managed from Admin → Coin packages.
  await prisma.coinPackage.upsert({
    where: { id: 'seed-ng-1000' },
    update: {},
    create: {
      id: 'seed-ng-1000',
      countryCode: 'NG',
      currencyCode: 'NGN',
      coinAmount: 1000,
      priceMinor: 100000, // ₦1,000.00 in kobo
    },
  });

  await prisma.gift.upsert({
    where: { code: 'ROSE' },
    update: {},
    create: { code: 'ROSE', name: 'Rose', coinPrice: 10, category: 'classic', icon: '🌹' },
  });

  // Registered DISABLED by default — flip to ACTIVE only after Phase 0
  // legal review clears a country, then enable per-country via
  // GameRegionConfig + RegionalConfig.gamesEnabled (both required).
  await prisma.gameDefinition.upsert({
    where: { code: 'LUCKY_NUMBER' },
    update: {},
    create: {
      code: 'LUCKY_NUMBER',
      name: 'Lucky Number',
      status: 'DISABLED',
      rulesJson: { payoutMultiplier: 20 },
    },
  });

  // Sum-dice numbers game (Big/Small/Odd/Even + individual number picks
  // against the sum of 3 dice, 0-9 each — see games/sum-dice-rules.ts for
  // the actual math). payoutMultiplier here is flat across every number
  // 0-27, per the confirmed design — not probability-weighted, so the
  // house edge comes from the aggregate distribution, not per-number odds.
  await prisma.gameDefinition.upsert({
    where: { code: 'SUM_DICE' },
    update: {},
    create: {
      code: 'SUM_DICE',
      name: 'Big Small Odd Even',
      status: 'DISABLED',
      rulesJson: { payoutMultiplier: 9, diceCount: 3, diceSides: 10 },
    },
  });

  // Crash (spec §44-46). growthRate is tuned so the multiplier reaches
  // 2.00x at ~5 seconds into the live phase — see games/crash-rules.ts.
  // houseEdge of 3% matches the (1-houseEdge)/(1-r) formula's defining
  // property: the expected return is (1-houseEdge) regardless of what
  // multiplier a player tries to cash out at.
  await prisma.gameDefinition.upsert({
    where: { code: 'CRASH' },
    update: {},
    create: {
      code: 'CRASH',
      name: 'Crash',
      status: 'DISABLED',
      rulesJson: { houseEdge: 0.03, growthRate: Math.log(2) / 5 },
    },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });