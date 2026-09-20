import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { KycService } from './kyc.service';
import { ageInYears, cleanFullName, cleanIdNumber, decodeKycImage, hashIdNumber, namesMatch, parseDateOfBirth } from './kyc-rules';

// a tiny valid-looking JPEG: correct magic bytes, padded past the minimum size
const jpeg = (bytes = 8000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes, 1)]).toString('base64');
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8000, 2)]).toString('base64');

describe('kyc rules', () => {
  it('requires a full legal name', () => {
    expect(cleanFullName('  Ada   Obi ')).toBe('Ada Obi');
    expect(cleanFullName("Chidi O'Neil-Adeyemi")).toBe("Chidi O'Neil-Adeyemi");
    expect(() => cleanFullName('Ada')).toThrow(BadRequestException);
    expect(() => cleanFullName('A B')).toThrow(BadRequestException);
    expect(() => cleanFullName('12345 67890')).toThrow(BadRequestException);
    expect(() => cleanFullName(undefined)).toThrow(BadRequestException);
  });

  it('checks the date of birth is real and an adult', () => {
    const now = new Date('2026-09-20T12:00:00Z');
    expect(parseDateOfBirth('1995-05-17', now).toISOString()).toBe('1995-05-17T00:00:00.000Z');
    expect(() => parseDateOfBirth('2010-01-01', now)).toThrow(/at least 18/);
    expect(() => parseDateOfBirth('2008-09-21', now)).toThrow(/at least 18/); // turns 18 tomorrow
    expect(parseDateOfBirth('2008-09-20', now)).toBeInstanceOf(Date); // turns 18 today
    expect(() => parseDateOfBirth('1995-02-30', now)).toThrow(/not a real date/);
    expect(() => parseDateOfBirth('17/05/1995', now)).toThrow(/YYYY-MM-DD/);
    expect(() => parseDateOfBirth('1850-01-01', now)).toThrow(/does not look right/);
    expect(ageInYears(new Date('2000-09-21T00:00:00Z'), now)).toBe(25);
  });

  it('validates ID numbers by type', () => {
    expect(cleanIdNumber('NIN', '123 4567 8901')).toBe('12345678901');
    expect(() => cleanIdNumber('NIN', '1234567890')).toThrow(/11 digits/);
    expect(cleanIdNumber('PASSPORT', 'a-12345678')).toBe('A12345678');
    expect(() => cleanIdNumber('PASSPORT', '12')).toThrow(BadRequestException);
  });

  it('hashes the ID number with a secret, never storing it, and the same ID always hashes the same', () => {
    const h = hashIdNumber('s3cret', 'NIN', '12345678901');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('12345678901');
    expect(hashIdNumber('s3cret', 'NIN', '12345678901')).toBe(h);
    expect(hashIdNumber('other', 'NIN', '12345678901')).not.toBe(h);
    expect(hashIdNumber('s3cret', 'PASSPORT', '12345678901')).not.toBe(h);
  });

  it('accepts real JPEG/PNG photos and rejects everything else, judging by the bytes', () => {
    expect(decodeKycImage(jpeg(), 'ID').contentType).toBe('image/jpeg');
    expect(decodeKycImage(`data:image/png;base64,${png()}`, 'ID').contentType).toBe('image/png');
    expect(() => decodeKycImage(Buffer.from('%PDF-1.4 ' + 'x'.repeat(9000)).toString('base64'), 'ID')).toThrow(/JPEG, PNG or WebP/);
    expect(() => decodeKycImage(jpeg(100), 'ID')).toThrow(/too small/);
    expect(() => decodeKycImage(jpeg(4 * 1024 * 1024), 'ID')).toThrow(/too large/);
    expect(() => decodeKycImage('***not base64***', 'ID')).toThrow(/valid image/);
    expect(() => decodeKycImage(undefined, 'ID')).toThrow(/required/);
  });

  it('gives reviewers a name-match hint (order, case and accents ignored)', () => {
    expect(namesMatch('Ada Obi', 'obi ada')).toBe(true);
    expect(namesMatch('Ada Chinwe Obi', 'ADA OBI')).toBe(true);
    expect(namesMatch('Ada Obi', 'Bola Ade')).toBe(false);
    expect(namesMatch('Ada Obi', null)).toBeNull();
    expect(namesMatch('José Álvarez', 'jose alvarez')).toBe(true);
  });
});

function build(over: { verified?: boolean; pending?: any; clash?: any; sub?: any } = {}) {
  const created: any[] = [];
  const updates: any[] = [];
  const tx = {
    kycSubmission: {
      create: jest.fn(async ({ data }: any) => { created.push(data); return { id: 's1', status: 'PENDING', submittedAt: new Date(), reviewedAt: null, rejectionReason: null, ...data, documents: undefined }; }),
      findUnique: jest.fn().mockResolvedValue(over.sub ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(async ({ data }: any) => ({ ...(over.sub ?? {}), ...data })),
    },
    user: { update: jest.fn(async (a: any) => { updates.push(a); return {}; }) },
  };
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ kycVerified: over.verified ?? false }) },
    kycSubmission: {
      findFirst: jest.fn(async ({ where }: any) => (where.status === 'PENDING' && where.userId === 'u1' ? (over.pending ?? null) : (over.clash ?? null))),
      findUnique: tx.kycSubmission.findUnique,
      update: tx.kycSubmission.update,
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const audit: any = { record: jest.fn() };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const config: any = { get: (k: string) => (k === 'KYC_HASH_SECRET' ? 'secret' : undefined) };
  return { svc: new KycService(prisma, config, audit, notifications), prisma, tx, created, updates, audit, notifications };
}

const input = { fullName: 'Ada Obi', dateOfBirth: '1995-05-17', idType: 'NIN', idNumber: '12345678901', idImage: jpeg(), selfieImage: jpeg() };

describe('KycService.submit', () => {
  it('stores the submission for review with only the last 4 digits and a hash of the ID number', async () => {
    const { svc, created, audit } = build();
    const out = await svc.submit('u1', input);
    expect(out).toMatchObject({ status: 'PENDING', idLast4: '8901', fullName: 'Ada Obi' });
    expect(created[0].idLast4).toBe('8901');
    expect(created[0].idNumberHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify({ ...created[0], documents: undefined })).not.toContain('12345678901');
    expect(created[0].documents.create.map((d: any) => d.kind)).toEqual(['ID_FRONT', 'SELFIE']);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'kyc.submit' }));
  });

  it('refuses someone who is already verified, or who already has a submission under review', async () => {
    await expect(build({ verified: true }).svc.submit('u1', input)).rejects.toBeInstanceOf(ConflictException);
    await expect(build({ pending: { id: 'p' } }).svc.submit('u1', input)).rejects.toThrow(/already being reviewed/);
  });

  it('refuses an ID that another account has already used, without saying whose', async () => {
    const { svc, created } = build({ clash: { id: 'other' } });
    await expect(svc.submit('u1', input)).rejects.toThrow(/cannot be used for this account/);
    expect(created).toHaveLength(0);
  });

  it('rejects bad input before touching the database', async () => {
    const { svc, prisma } = build();
    await expect(svc.submit('u1', { ...input, dateOfBirth: '2015-01-01' })).rejects.toThrow(/at least 18/);
    await expect(svc.submit('u1', { ...input, idImage: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('KycService review', () => {
  const pending = { id: 's1', userId: 'u1', status: 'PENDING', idNumberHash: 'h', fullName: 'Ada Obi', idType: 'NIN', idLast4: '8901', submittedAt: new Date(), reviewedAt: null, rejectionReason: null };

  it('approving marks the submission and the user verified together, audits it, and tells the person', async () => {
    const { svc, updates, audit, notifications } = build({ sub: pending });
    const out = await svc.approve('s1', 'admin-1', ['TRUST_SAFETY_ADMIN'] as any);
    expect(out.status).toBe('APPROVED');
    expect(updates[0]).toEqual({ where: { id: 'u1' }, data: { kycVerified: true } });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'kyc.approve', actorId: 'admin-1' }));
    expect(notifications.notify).toHaveBeenCalledWith('u1', 'SECURITY', { event: 'kyc_approved' });
  });

  it('nobody can approve or reject their own check', async () => {
    const { svc } = build({ sub: pending });
    await expect(svc.approve('s1', 'u1', ['SUPER_ADMIN'] as any)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.reject('s1', 'u1', ['SUPER_ADMIN'] as any, 'blurry photo')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a decided submission cannot be decided again', async () => {
    const { svc } = build({ sub: { ...pending, status: 'APPROVED' } });
    await expect(svc.approve('s1', 'admin-1', [] as any)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.reject('s1', 'admin-1', [] as any, 'too late')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejecting needs a reason, does not verify the user, and passes the reason to the person', async () => {
    const { svc, updates, notifications } = build({ sub: pending });
    await expect(svc.reject('s1', 'admin-1', [] as any, ' ')).rejects.toBeInstanceOf(BadRequestException);
    const out = await svc.reject('s1', 'admin-1', ['SUPER_ADMIN'] as any, 'The selfie is blurry');
    expect(out).toMatchObject({ status: 'REJECTED', rejectionReason: 'The selfie is blurry' });
    expect(updates).toHaveLength(0);
    expect(notifications.notify).toHaveBeenCalledWith('u1', 'SECURITY', { event: 'kyc_rejected', reason: 'The selfie is blurry' });
  });

  it('a missing submission is a 404, and only image kinds we know are served', async () => {
    const { svc } = build({ sub: null });
    await expect(svc.approve('nope', 'admin-1', [] as any)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.document('s1', 'PASSWORD', 'admin-1', [] as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('every look at an identity photo is audited', async () => {
    const prisma: any = { kycDocument: { findUnique: jest.fn().mockResolvedValue({ contentType: 'image/jpeg', data: Buffer.from('abc') }) } };
    const audit: any = { record: jest.fn() };
    const svc = new KycService(prisma, { get: () => 's' } as any, audit, {} as any);
    const doc = await svc.document('s1', 'SELFIE', 'admin-1', ['SUPER_ADMIN'] as any);
    expect(doc.contentType).toBe('image/jpeg');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'kyc.view_document', metadata: { kind: 'SELFIE' } }));
  });
});

describe("a person's own status never includes anyone else's or a reviewer's reason for approval", () => {
  it('only shows a rejection reason for rejected submissions', async () => {
    const row = { id: 's', status: 'APPROVED', submittedAt: new Date(), reviewedAt: new Date(), rejectionReason: 'stale', fullName: 'Ada Obi', idType: 'NIN', idLast4: '8901' };
    const prisma: any = { user: { findUnique: jest.fn().mockResolvedValue({ kycVerified: true }) }, kycSubmission: { findFirst: jest.fn().mockResolvedValue(row) } };
    const out = await new KycService(prisma, { get: () => 's' } as any, {} as any, {} as any).statusFor('u1');
    expect(out).toMatchObject({ verified: true, submission: { status: 'APPROVED', rejectionReason: null } });
  });
});
