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

  // Lucky Number: three independent secure server-side digits (0-9) are
  // summed to 0-27. RTP and base prize drive the per-number multiplier and
  // suggested stake table at runtime; nothing is hard-coded into the payout
  // table. SUM_DICE remains the code for existing navigation/API compatibility.
  await prisma.gameDefinition.upsert({
    where: { code: 'SUM_DICE' },
    update: {},
    create: {
      code: 'SUM_DICE',
      name: 'Lucky Number',
      status: 'DISABLED',
      rulesJson: { rtp: 0.95, basePrize: 1000, stakeWeightExponent: 1.2798473, diceCount: 3, diceSides: 10, openSeconds: 30, minStake: 1, maxStake: 1000000 },
    },
  });

  // Ludo is a persistent real-time paid match. It is disabled by default
  // until the operator enables the game and its country region.
  await prisma.gameDefinition.upsert({
    where: { code: 'LUDO' },
    update: {},
    create: {
      code: 'LUDO',
      name: 'Ludo',
      status: 'DISABLED',
      rulesJson: { minEntry: 100, maxEntry: 500000, turnSeconds: 20, reconnectSeconds: 120, prizeFirstPercent: 66.67, prizeSecondPercent: 33.33, prizeFirstPercent2p: 100 },
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