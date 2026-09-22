import { isOriginAllowed, parseOrigins } from './cors';

describe('CORS origin rules', () => {
  it('parses the setting, ignoring spaces, empties and trailing slashes', () => {
    expect(parseOrigins(' https://a.com/ , ,http://localhost:5173 ')).toEqual(['https://a.com', 'http://localhost:5173']);
    expect(parseOrigins(undefined)).toEqual([]);
  });

  it('requests with no Origin (mobile app, Paystack webhooks, curl) are always allowed', () => {
    expect(isOriginAllowed(undefined, [], true)).toBe(true);
  });

  it('in production only the listed origins are allowed — not localhost, not others', () => {
    const allowed = ['https://admin.example.com', 'http://localhost:5173'];
    expect(isOriginAllowed('https://admin.example.com', allowed, true)).toBe(true);
    expect(isOriginAllowed('https://admin.example.com/', allowed, true)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', allowed, true)).toBe(true); // listed explicitly
    expect(isOriginAllowed('http://localhost:3000', allowed, true)).toBe(false);
    expect(isOriginAllowed('https://evil.example.net', allowed, true)).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', [], true)).toBe(false); // nothing listed = nothing allowed
  });

  it('in development localhost on any port is allowed, other sites still are not', () => {
    expect(isOriginAllowed('http://localhost:5173', [], false)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:4000', [], false)).toBe(true);
    expect(isOriginAllowed('https://evil.example.net', [], false)).toBe(false);
    expect(isOriginAllowed('http://localhost.evil.com', [], false)).toBe(false);
  });
});
