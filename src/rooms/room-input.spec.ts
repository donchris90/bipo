import { BadRequestException } from '@nestjs/common';
import { cleanRoomInput } from './room-input';

describe('cleanRoomInput — starting a party', () => {
  it('the request from the log (privacy "") no longer breaks: blank privacy means public', () => {
    const out = cleanRoomInput({ title: 'Party Room', privacy: '', seatCount: 6, mode: 'VIDEO' });
    expect(out).toMatchObject({ title: 'Party Room', privacy: 'PUBLIC', seatCount: 6, mode: 'VIDEO' });
  });

  it('missing, null and whitespace-only values all get the defaults', () => {
    expect(cleanRoomInput({})).toEqual({ title: 'Party Room', privacy: 'PUBLIC', seatCount: 8, category: undefined, themeColor: undefined, mode: 'AUDIO' });
    expect(cleanRoomInput({ title: '   ', privacy: null, seatCount: '', category: '  ' })).toMatchObject({ title: 'Party Room', privacy: 'PUBLIC', seatCount: 8, category: undefined });
  });

  it('accepts the real privacy values in any case', () => {
    for (const [given, want] of [['private', 'PRIVATE'], ['Followers-Only', 'FOLLOWERS_ONLY'], ['INVITE_ONLY', 'INVITE_ONLY'], ['public', 'PUBLIC']] as const) {
      expect(cleanRoomInput({ privacy: given }).privacy).toBe(want);
    }
  });

  it('a genuinely wrong privacy is a 400 that lists the choices — not a 500', () => {
    expect(() => cleanRoomInput({ privacy: 'everyone' })).toThrow(BadRequestException);
    expect(() => cleanRoomInput({ privacy: 'everyone' })).toThrow(/PUBLIC, PRIVATE, FOLLOWERS_ONLY, INVITE_ONLY/);
  });

  it('seat count: text numbers work, values snap to a real layout, non-numbers are refused', () => {
    expect(cleanRoomInput({ seatCount: '6' }).seatCount).toBe(6);
    expect(cleanRoomInput({ seatCount: 8 }).seatCount).toBe(8);
    expect(cleanRoomInput({ seatCount: 5 }).seatCount).toBe(6);
    expect(cleanRoomInput({ seatCount: 7 }).seatCount).toBe(8);
    expect(cleanRoomInput({ seatCount: 10 }).seatCount).toBe(9);
    expect(cleanRoomInput({ seatCount: 11 }).seatCount).toBe(12);
    expect(cleanRoomInput({ seatCount: 2 }).seatCount).toBe(4);
    expect(cleanRoomInput({ seatCount: 99 }).seatCount).toBe(12);
    expect(() => cleanRoomInput({ seatCount: 'many' })).toThrow(/whole number/);
    expect(() => cleanRoomInput({ seatCount: 6.5 })).toThrow(/whole number/);
  });

  it('title, category and colour are tidied and bounded', () => {
    expect(cleanRoomInput({ title: '  Late   night   chat ' }).title).toBe('Late night chat');
    expect(() => cleanRoomInput({ title: 'x'.repeat(61) })).toThrow(/60 characters/);
    expect(() => cleanRoomInput({ category: 'x'.repeat(31) })).toThrow(/30 characters/);
    expect(cleanRoomInput({ themeColor: '#FF00AA' }).themeColor).toBe('#FF00AA');
    expect(cleanRoomInput({ themeColor: 'red' }).themeColor).toBeUndefined();
  });

  it('mode is video only when asked, otherwise audio', () => {
    expect(cleanRoomInput({ mode: 'video' }).mode).toBe('VIDEO');
    expect(cleanRoomInput({ mode: 'whatever' }).mode).toBe('AUDIO');
    expect(cleanRoomInput({}).mode).toBe('AUDIO');
  });
});
