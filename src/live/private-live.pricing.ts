// Rules for paid private 1-on-1 live. Pure functions only (no database, no clock) so the money
// maths can be tested on its own.

// Fixed split for every private session. It deliberately ignores the per-country revenue split.
export const PRIVATE_HOST_SHARE_BPS = 6000; // host 60%
export const PRIVATE_PLATFORM_SHARE_BPS = 10_000 - PRIVATE_HOST_SHARE_BPS; // platform 40%

// Host feature unlock (Host Levels). Seeded on level 3.
export const PRIVATE_LIVE_UNLOCK = 'PRIVATE_LIVE';

export const PRIVATE_RATE_LIMITS = {
  maxPackages: 6,
  minMinutes: 1,
  maxMinutes: 120,
  minPriceCoins: 10,
  maxPriceCoins: 10_000_000,
  // Longest a single session can run once renewals are stacked on top of each other.
  maxSessionMinutes: 240,
  // Optional text a host writes for each package: what they intend to offer for that rate.
  maxDescriptionLength: 300,
} as const;

// The host has this long to accept a paid request before it is refunded.
export const PRIVATE_ACCEPT_WINDOW_MS = 45_000;
// After accepting, the viewer has this long to actually join before the slot reopens and they are refunded.
export const PRIVATE_JOIN_WINDOW_MS = 60_000;

export interface RatePackageInput {
  minutes: number;
  priceCoins: number;
  description: string | null;
}

export type RateCardResult = { ok: true; packages: RatePackageInput[] } | { ok: false; error: string };

export function validateRateCard(input: unknown): RateCardResult {
  const L = PRIVATE_RATE_LIMITS;
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: 'Add at least one package (for example 5 minutes for 200 coins).' };
  }
  if (input.length > L.maxPackages) {
    return { ok: false, error: `You can have at most ${L.maxPackages} packages.` };
  }
  const seen = new Set<number>();
  const packages: RatePackageInput[] = [];
  for (const raw of input) {
    const minutes = Number((raw as any)?.minutes);
    const priceCoins = Number((raw as any)?.priceCoins);
    if (!Number.isInteger(minutes) || minutes < L.minMinutes || minutes > L.maxMinutes) {
      return { ok: false, error: `Minutes must be a whole number from ${L.minMinutes} to ${L.maxMinutes}.` };
    }
    if (!Number.isInteger(priceCoins) || priceCoins < L.minPriceCoins || priceCoins > L.maxPriceCoins) {
      return { ok: false, error: `Each price must be a whole number from ${L.minPriceCoins} to ${L.maxPriceCoins.toLocaleString('en-US')} coins.` };
    }
    if (seen.has(minutes)) {
      return { ok: false, error: `You listed ${minutes} minutes more than once.` };
    }
    const rawDescription = (raw as any)?.description;
    if (rawDescription != null && typeof rawDescription !== 'string') {
      return { ok: false, error: 'The description must be text.' };
    }
    const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';
    if (description.length > L.maxDescriptionLength) {
      return { ok: false, error: `Descriptions can be at most ${L.maxDescriptionLength} characters.` };
    }
    seen.add(minutes);
    packages.push({ minutes, priceCoins, description: description || null });
  }
  packages.sort((a, b) => a.minutes - b.minutes);
  return { ok: true, packages };
}

export function splitDelivered(deliveredCoins: number): { hostCoins: number; platformCoins: number } {
  const hostCoins = Math.floor((deliveredCoins * PRIVATE_HOST_SHARE_BPS) / 10_000);
  return { hostCoins, platformCoins: deliveredCoins - hostCoins };
}

export interface BlockSettlement {
  deliveredSeconds: number;
  refundCoins: number;
  deliveredCoins: number;
  hostCoins: number;
  platformCoins: number;
}

// Settles ONE paid block (the first purchase, or one renewal) when the session is over.
//  - viewerLeft: the viewer ended it. No refund for unused time; the host is paid for the whole block.
//  - otherwise (host ended it, host dropped, or the time simply ran out): the viewer gets back the
//    unused part of the block at that block's own per-minute rate, and the host is paid for the
//    time actually delivered. A block that never started is refunded in full.
export function settleBlock(args: {
  priceCoins: number;
  durationSeconds: number;
  blockStartsAtMs: number;
  nowMs: number;
  viewerLeft: boolean;
}): BlockSettlement {
  const { priceCoins, durationSeconds, blockStartsAtMs, nowMs, viewerLeft } = args;
  const deliveredSeconds = viewerLeft
    ? durationSeconds
    : Math.min(durationSeconds, Math.max(0, Math.floor((nowMs - blockStartsAtMs) / 1000)));
  const refundCoins = viewerLeft
    ? 0
    : Math.floor((priceCoins * (durationSeconds - deliveredSeconds)) / durationSeconds);
  const deliveredCoins = priceCoins - refundCoins;
  const { hostCoins, platformCoins } = splitDelivered(deliveredCoins);
  return { deliveredSeconds, refundCoins, deliveredCoins, hostCoins, platformCoins };
}
