import { KYC_PHOTO_RETENTION_DAYS, KycRetentionService } from './kyc-retention.service';

describe('identity photo retention', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('deletes photos of DECIDED submissions reviewed more than 7 days ago — never pending ones', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 4 });
    const svc = new KycRetentionService({ kycDocument: { deleteMany } } as any);
    const now = Date.UTC(2026, 8, 20);
    expect(await svc.purge(now)).toBe(4);
    const where = deleteMany.mock.calls[0][0].where.submission;
    expect(where.status).toEqual({ in: ['APPROVED', 'REJECTED'] });
    expect(where.reviewedAt.lt.getTime()).toBe(now - KYC_PHOTO_RETENTION_DAYS * DAY);
    expect(KYC_PHOTO_RETENTION_DAYS).toBe(7);
  });

  it('a failed cleanup never throws (it retries next hour)', async () => {
    const svc = new KycRetentionService({ kycDocument: { deleteMany: jest.fn().mockRejectedValue(new Error('db')) } } as any);
    await expect(svc.purge()).resolves.toBe(0);
  });
});
