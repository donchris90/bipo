import { createHmac, timingSafeEqual } from 'crypto';

// Paystack signs the exact raw request body with HMAC-SHA512 using the
// merchant's secret key, hex-encoded, sent as the `x-paystack-signature`
// header. This must be checked against the true raw bytes (see main.ts's
// rawBody comment) — verifying against a re-serialized JSON object is not
// a real check, since it can silently pass even when the bytes differ.
//
// timingSafeEqual (not ===) specifically to avoid a timing side-channel
// that would let an attacker discover the correct signature byte-by-byte.
export function verifyPaystackSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined | null,
  secretKey: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws on mismatched lengths rather than returning
  // false — an invalid/truncated header must not crash the request.
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
