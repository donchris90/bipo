import { BadRequestException } from '@nestjs/common';

export const ROOM_PRIVACY = ['PUBLIC', 'PRIVATE', 'FOLLOWERS_ONLY', 'INVITE_ONLY'] as const;
export type RoomPrivacyValue = (typeof ROOM_PRIVACY)[number];

// The only seat layouts the app draws. Create, the in-room picker and
// setSeatCount all use this one list so a room can never end up with a count
// the host can't select again later.
export const ROOM_SEAT_COUNTS = [4, 6, 8, 9, 12] as const;
export const DEFAULT_SEAT_COUNT = 8;

// Nearest allowed layout; a tie goes to the larger one (5 -> 6, 7 -> 8).
export function snapSeatCount(n: number): number {
  let best: number = ROOM_SEAT_COUNTS[0];
  for (const c of ROOM_SEAT_COUNTS) {
    if (Math.abs(c - n) < Math.abs(best - n) || (Math.abs(c - n) === Math.abs(best - n) && c > best)) best = c;
  }
  return best;
}

export interface CleanRoomInput {
  title: string;
  privacy: RoomPrivacyValue;
  seatCount: number;
  category: string | undefined;
  themeColor: string | undefined;
  mode: 'VIDEO' | 'AUDIO';
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// Checks what the app sends when starting a party, BEFORE it reaches the database.
// A blank privacy ("") used to go straight through to Prisma, which rejected it
// and turned into "Internal server error" for the person starting the party.
// Now: anything missing or blank gets the sensible default; anything genuinely
// wrong gets a 400 that says what to fix.
export function cleanRoomInput(body: Record<string, unknown>): CleanRoomInput {
  // title
  let title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
  if (!title) title = 'Party Room';
  if (title.length > 60) throw new BadRequestException('The party title can be at most 60 characters');

  // privacy: blank -> public; otherwise must be one of the known values (any case)
  let privacy: RoomPrivacyValue = 'PUBLIC';
  if (!blank(body.privacy)) {
    const p = String(body.privacy).trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!(ROOM_PRIVACY as readonly string[]).includes(p)) {
      throw new BadRequestException(`privacy must be one of: ${ROOM_PRIVACY.join(', ')}`);
    }
    privacy = p as RoomPrivacyValue;
  }

  // seatCount: a whole number (the app or a form may send it as text), snapped
  // to one of the layouts the app can draw (4, 6, 8, 9, 12).
  let seatCount = DEFAULT_SEAT_COUNT;
  if (!blank(body.seatCount)) {
    const n = Number(body.seatCount);
    if (!Number.isInteger(n)) throw new BadRequestException('seatCount must be a whole number');
    seatCount = snapSeatCount(n);
  }

  // category
  let category: string | undefined;
  if (!blank(body.category)) {
    category = String(body.category).trim();
    if (category.length > 30) throw new BadRequestException('category can be at most 30 characters');
  }

  // themeColor: #RRGGBB or nothing
  const themeColor = typeof body.themeColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(body.themeColor) ? body.themeColor : undefined;

  const mode = typeof body.mode === 'string' && body.mode.toUpperCase() === 'VIDEO' ? 'VIDEO' : 'AUDIO';

  return { title, privacy, seatCount, category, themeColor, mode };
}
