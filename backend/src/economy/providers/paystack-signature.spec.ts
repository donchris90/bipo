import { createHmac } from 'crypto';
import { verifyPaystackSignature } from './paystack-signature';

const SECRET = 'sk_test_fake_secret_for_testing_only';
const BODY = JSON.stringify({ event: 'charge.success', data: { reference: 'abc123', amount: 10000 } });

function realSignatureFor(body: string, secret: string): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

describe('verifyPaystackSignature', () => {
  it('accepts a genuinely correctly-signed body', () => {
    const signature = realSignatureFor(BODY, SECRET);
    expect(verifyPaystackSignature(BODY, signature, SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const signature = realSignatureFor(BODY, 'wrong_secret');
    expect(verifyPaystackSignature(BODY, signature, SECRET)).toBe(false);
  });

  it('rejects when the body has been tampered with after signing', () => {
    const signature = realSignatureFor(BODY, SECRET);
    const tamperedBody = JSON.stringify({ event: 'charge.success', data: { reference: 'abc123', amount: 999999999 } });
    expect(verifyPaystackSignature(tamperedBody, signature, SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyPaystackSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyPaystackSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyPaystackSignature(BODY, '', SECRET)).toBe(false);
  });

  it('rejects a well-formed but simply wrong signature, without throwing', () => {
    const wrongButSameLength = 'a'.repeat(128); // SHA-512 hex digest is 128 chars
    expect(() => verifyPaystackSignature(BODY, wrongButSameLength, SECRET)).not.toThrow();
    expect(verifyPaystackSignature(BODY, wrongButSameLength, SECRET)).toBe(false);
  });

  it('rejects a truncated/malformed signature without throwing', () => {
    expect(() => verifyPaystackSignature(BODY, 'short', SECRET)).not.toThrow();
    expect(verifyPaystackSignature(BODY, 'short', SECRET)).toBe(false);
  });

  it('works identically whether the body is passed as a string or a Buffer', () => {
    const signature = realSignatureFor(BODY, SECRET);
    expect(verifyPaystackSignature(Buffer.from(BODY, 'utf8'), signature, SECRET)).toBe(true);
  });
});


describe('Paystack payment references', () => {
  it('normalizes arbitrary idempotency keys into a valid bounded reference', async () => {
    const { toPaystackPaymentReference } = await import('./paystack-payment-provider');
    const ref = toPaystackPaymentReference('UUID/with spaces and symbols!!!');
    expect(ref).toMatch(/^[a-z0-9_-]+$/);
    expect(ref.length).toBeGreaterThanOrEqual(16);
    expect(ref.length).toBeLessThanOrEqual(50);
  });
});

describe('Paystack payment reference collision resistance', () => {
  it('keeps distinct long idempotency keys distinct', async () => {
    const { toPaystackPaymentReference } = await import('./paystack-payment-provider');
    const a = toPaystackPaymentReference('same-prefix-' + 'a'.repeat(200));
    const b = toPaystackPaymentReference('same-prefix-' + 'b'.repeat(200));
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(50);
    expect(b.length).toBeLessThanOrEqual(50);
  });
});
