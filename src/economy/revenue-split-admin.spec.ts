import { BadRequestException } from '@nestjs/common';
import { RevenueSplitAdminService } from './revenue-split-admin.service';

describe('RevenueSplitAdminService', () => {
  function build() {
    const rows: any[] = [];
    const prisma: any = { revenueSplitConfig: {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async () => rows.filter(r => r.active).sort((a,b) => +b.effectiveFrom - +a.effectiveFrom)[0] ?? null),
      create: jest.fn(async ({ data }: any) => { const row = { id: `r${rows.length + 1}`, effectiveFrom: new Date(), ...data }; rows.push(row); return row; }),
    }};
    const audit: any = { record: jest.fn() };
    return { svc: new RevenueSplitAdminService(prisma, audit), prisma, audit, rows };
  }

  it('validates global shares and audits the change', async () => {
    const { svc, audit } = build();
    const saved = await svc.upsert({ scope: 'GLOBAL', creatorShareBps: 7000, platformShareBps: 3000, agencyShareBps: 700 }, 'admin', ['FINANCE_ADMIN'] as any);
    expect(saved).toMatchObject({ scope: 'GLOBAL', scopeKey: null, creatorShareBps: 7000, platformShareBps: 3000, agencyShareBps: 700 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'revenue_split.create', actorId: 'admin' }));
  });

  it('rejects invalid scope, totals, agency commission and active values', async () => {
    const { svc } = build();
    await expect(svc.upsert({ scope: 'GLOBAL', scopeKey: 'NG', creatorShareBps: 7000, platformShareBps: 3000 }, 'a', [] as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upsert({ scope: 'COUNTRY', scopeKey: 'NGA', creatorShareBps: 7000, platformShareBps: 3000 }, 'a', [] as any)).rejects.toThrow(/ISO-2/);
    await expect(svc.upsert({ scope: 'GLOBAL', creatorShareBps: 6000, platformShareBps: 3000 }, 'a', [] as any)).rejects.toThrow(/total 10000/);
    await expect(svc.upsert({ scope: 'GLOBAL', creatorShareBps: 7000, platformShareBps: 3000, agencyShareBps: 7001 }, 'a', [] as any)).rejects.toThrow(/cannot exceed/);
    await expect(svc.upsert({ scope: 'GLOBAL', creatorShareBps: 7000, platformShareBps: 3000, active: 'false' }, 'a', [] as any)).rejects.toThrow(/active/);
  });
});
