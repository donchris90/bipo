import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { detectImageType } from '../uploads/image-rules';

// Validation and helpers for identity verification, kept pure so the rules have
// direct tests. Nothing here talks to a database.

export const ID_TYPES = ['NIN', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'PASSPORT'] as const;
export type IdType = (typeof ID_TYPES)[number];

export const MIN_AGE = 18;
export const MAX_KYC_IMAGE_BYTES = 3 * 1024 * 1024;
const MIN_KYC_IMAGE_BYTES = 5 * 1024; // a real photo, not a 1-pixel file

const NAME_RE = /^[\p{L}][\p{L}\p{M}'’.\- ]{2,119}$/u;

export function cleanFullName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!NAME_RE.test(name) || name.split(' ').filter((t) => t.length >= 2).length < 2) {
    throw new BadRequestException('Enter your full legal name exactly as it appears on your ID (first and last name)');
  }
  return name;
}

// "YYYY-MM-DD" -> a Date at midnight UTC, and the person must be an adult.
export function parseDateOfBirth(raw: unknown, now = new Date()): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new BadRequestException('Date of birth must be in the form YYYY-MM-DD');
  const dob = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== raw) throw new BadRequestException('That date of birth is not a real date');
  const age = ageInYears(dob, now);
  if (age < MIN_AGE) throw new BadRequestException(`You must be at least ${MIN_AGE} to verify your identity`);
  if (age > 120) throw new BadRequestException('That date of birth does not look right');
  return dob;
}

export function ageInYears(dob: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function cleanIdType(raw: unknown): IdType {
  const t = typeof raw === 'string' ? raw.toUpperCase() : '';
  const found = ID_TYPES.find((x) => x === t);
  if (!found) throw new BadRequestException(`ID type must be one of: ${ID_TYPES.join(', ')}`);
  return found;
}

// Upper-cased, spaces and dashes removed. A Nigerian NIN is exactly 11 digits.
export function cleanIdNumber(type: IdType, raw: unknown): string {
  const n = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
  if (type === 'NIN') {
    if (!/^\d{11}$/.test(n)) throw new BadRequestException('A NIN is 11 digits');
  } else if (!/^[A-Z0-9]{6,20}$/.test(n)) {
    throw new BadRequestException('Enter the ID number exactly as printed on the document');
  }
  return n;
}

// A keyed hash, not the number: lets us notice one ID being used on several
// accounts without ever storing the ID number itself.
export function hashIdNumber(secret: string, type: IdType, number: string): string {
  return createHmac('sha256', secret).update(`${type}:${number}`).digest('hex');
}

export interface KycImage {
  bytes: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

// Accepts base64 (or a data URI) of a JPEG, PNG or WebP photo of a sensible size.
// The bytes decide what the file is, not what the client claims.
export function decodeKycImage(input: unknown, label: string): KycImage {
  if (typeof input !== 'string' || input.length === 0) throw new BadRequestException(`${label} is required`);
  const base64 = input.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new BadRequestException(`${label} is not a valid image`);
  if (Math.floor((base64.length * 3) / 4) > MAX_KYC_IMAGE_BYTES + 3) {
    throw new BadRequestException(`${label} is too large (limit ${MAX_KYC_IMAGE_BYTES / (1024 * 1024)} MB). Retake it with a lower quality setting.`);
  }
  const bytes = Buffer.from(base64, 'base64');
  const type = detectImageType(bytes);
  if (type !== 'jpeg' && type !== 'png' && type !== 'webp') throw new BadRequestException(`${label} must be a JPEG, PNG or WebP photo`);
  if (bytes.length < MIN_KYC_IMAGE_BYTES) throw new BadRequestException(`${label} is too small to be a readable photo`);
  return { bytes, contentType: `image/${type}` as KycImage['contentType'] };
}

// For the reviewer: do two names plausibly refer to the same person? Compares
// name parts ignoring case, order and punctuation; every part of the shorter
// name must appear in the longer. A hint only — a human makes the decision.
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!a || !b) return null;
  const parts = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
  const pa = parts(a);
  const pb = parts(b);
  if (pa.length === 0 || pb.length === 0) return null;
  const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  return short.every((t) => long.includes(t));
}
