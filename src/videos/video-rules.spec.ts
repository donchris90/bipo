import { BadRequestException } from '@nestjs/common';
import { cleanOptionalText, cleanTitle, extensionFor, keyBelongsTo, storageKeyFor } from './video-rules';

describe('extensionFor / storageKeyFor', () => {
  it('maps the allowed content types', () => {
    expect(extensionFor('video/mp4')).toBe('mp4');
    expect(extensionFor('video/quicktime')).toBe('mov');
    expect(storageKeyFor('u1', 'abc', 'video/webm')).toBe('videos/u1/abc.webm');
  });

  it('rejects anything that is not a supported video type', () => {
    expect(() => extensionFor('image/png')).toThrow(BadRequestException);
    expect(() => extensionFor('application/x-msdownload')).toThrow(BadRequestException);
  });
});

describe('keyBelongsTo', () => {
  it("accepts a key under the caller's own prefix", () => {
    expect(keyBelongsTo('u1', 'videos/u1/abc.mp4')).toBe(true);
  });

  it("rejects another user's key, traversal, and non-video extensions", () => {
    expect(keyBelongsTo('u1', 'videos/u2/abc.mp4')).toBe(false);
    expect(keyBelongsTo('u1', 'videos/u1/../u2/abc.mp4')).toBe(false);
    expect(keyBelongsTo('u1', 'videos/u1/abc.exe')).toBe(false);
    expect(keyBelongsTo('u1', 'videos/u10/abc.mp4')).toBe(false); // prefix must end at the slash
  });
});

describe('cleanTitle', () => {
  it('trims and requires a non-empty title within 100 chars', () => {
    expect(cleanTitle('  Night stream  ')).toBe('Night stream');
    expect(() => cleanTitle('   ')).toThrow(BadRequestException);
    expect(() => cleanTitle(undefined)).toThrow(BadRequestException);
    expect(() => cleanTitle('x'.repeat(101))).toThrow(BadRequestException);
  });
});

describe('cleanOptionalText', () => {
  it('distinguishes not-provided, cleared, and set', () => {
    expect(cleanOptionalText(undefined, 'Caption', 500)).toBeUndefined();
    expect(cleanOptionalText('   ', 'Caption', 500)).toBeNull();
    expect(cleanOptionalText(' hi ', 'Caption', 500)).toBe('hi');
  });

  it('enforces the max length and type', () => {
    expect(() => cleanOptionalText('x'.repeat(501), 'Caption', 500)).toThrow(BadRequestException);
    expect(() => cleanOptionalText(5, 'Caption', 500)).toThrow(BadRequestException);
  });
});
