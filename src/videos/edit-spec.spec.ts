import { BadRequestException } from '@nestjs/common';
import { cleanEditSpec, editKeyBelongsTo, editKeyFor, isNoEdit } from './edit-spec';

describe('cleanEditSpec', () => {
  it('defaults to "change nothing"', () => {
    expect(cleanEditSpec(undefined)).toEqual({ trim: null, speed: 1, filter: 'none', effect: 'none', music: { volumeOriginal: 1, volumeMusic: 0.8, startMs: 0 } });
  });

  it('accepts the choices the editor offers', () => {
    const s = cleanEditSpec({ trim: { startMs: 500, endMs: 4500 }, speed: 1.5, filter: 'warm', effect: 'vignette', music: { volumeOriginal: 0.2, volumeMusic: 1, startMs: 3000 } });
    expect(s).toMatchObject({ trim: { startMs: 500, endMs: 4500 }, speed: 1.5, filter: 'warm', effect: 'vignette' });
  });

  it('refuses anything outside the allow-list, naming what is wrong', () => {
    expect(() => cleanEditSpec({ speed: 3 })).toThrow(/speed must be one of/);
    expect(() => cleanEditSpec({ filter: 'rm -rf' })).toThrow(/filter must be one of/);
    expect(() => cleanEditSpec({ effect: "x';drop" })).toThrow(/effect must be one of/);
    expect(() => cleanEditSpec({ trim: { startMs: 5000, endMs: 5500 } })).toThrow(/at least 1 second/);
    expect(() => cleanEditSpec({ trim: { startMs: -1, endMs: 5000 } })).toThrow(/whole numbers/);
    expect(() => cleanEditSpec({ trim: { startMs: 0, endMs: 5000.5 } })).toThrow(/whole numbers/);
    expect(() => cleanEditSpec({ music: { volumeMusic: 2 } })).toThrow(/volumeMusic/);
    expect(() => cleanEditSpec('nope')).toThrow(BadRequestException);
  });

  it('knows when an edit changes nothing', () => {
    expect(isNoEdit(cleanEditSpec({}), false, false)).toBe(true);
    expect(isNoEdit(cleanEditSpec({}), true, false)).toBe(false);
    expect(isNoEdit(cleanEditSpec({ filter: 'mono' }), false, false)).toBe(false);
    expect(isNoEdit(cleanEditSpec({ trim: { startMs: 0, endMs: 3000 } }), false, false)).toBe(false);
  });
});

describe('edit file keys', () => {
  it('builds keys under the caller\'s own folder, for the right kinds of file', () => {
    expect(editKeyFor('u1', 'abc', 'overlay', 'image/png')).toBe('edits/u1/abc.png');
    expect(editKeyFor('u1', 'abc', 'music', 'audio/mpeg')).toBe('edits/u1/abc.mp3');
    expect(editKeyFor('u1', 'abc', 'music', 'audio/mp4')).toBe('edits/u1/abc.m4a');
    expect(() => editKeyFor('u1', 'abc', 'overlay', 'image/jpeg')).toThrow(/PNG/);
    expect(() => editKeyFor('u1', 'abc', 'music', 'video/mp4')).toThrow(/Unsupported music/);
  });

  it("only accepts a person's own files, of the right kind, with no path tricks", () => {
    expect(editKeyBelongsTo('u1', 'edits/u1/a.png', 'overlay')).toBe(true);
    expect(editKeyBelongsTo('u1', 'edits/u2/a.png', 'overlay')).toBe(false);
    expect(editKeyBelongsTo('u1', 'edits/u1/a.mp3', 'overlay')).toBe(false);
    expect(editKeyBelongsTo('u1', 'edits/u1/a.mp3', 'music')).toBe(true);
    expect(editKeyBelongsTo('u1', 'edits/u1/../u2/a.mp3', 'music')).toBe(false);
    expect(editKeyBelongsTo('u1', 'videos/u1/a.mp4', 'music')).toBe(false);
    expect(editKeyBelongsTo('u1', undefined, 'music')).toBe(false);
  });
});
