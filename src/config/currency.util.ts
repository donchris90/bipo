// spec §71: integer minor units only, never float/double, for any amount.
// spec §72: don't assume one currency. The piece those two sections don't
// spell out is that "minor unit" isn't always /100 — JPY has no minor unit
// at all, some currencies use 3 decimals. Getting this wrong silently
// produces amounts off by 10x/100x for the affected currency, so it's
// centralized here rather than assumed inline wherever a price is shown.
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  NGN: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  GBP: 2,
  USD: 2,
  EUR: 2,
  INR: 2,
  AED: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
};

export function minorUnitExponent(currencyCode: string): number {
  return MINOR_UNIT_EXPONENT[currencyCode.toUpperCase()] ?? 2; // 2 is the common case, not a safe universal default — verify before adding a new currency
}

// Converts a major-unit display amount (e.g. "10.50") the client might show
// into the integer minor units the ledger stores — inverse of the display
// formatting a client does. Backend business logic should work in minor
// units throughout; this is only for boundary conversions (e.g. an admin
// entering a CoinPackage price in the admin UI).
export function toMinorUnits(majorAmount: number, currencyCode: string): number {
  const exponent = minorUnitExponent(currencyCode);
  return Math.round(majorAmount * 10 ** exponent);
}

export function formatMinorUnits(minorAmount: number, currencyCode: string): string {
  const exponent = minorUnitExponent(currencyCode);
  const major = minorAmount / 10 ** exponent;
  return `${major.toFixed(exponent)} ${currencyCode.toUpperCase()}`;
}
