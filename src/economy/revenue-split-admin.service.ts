import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class RevenueSplitAdminService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list() {
    return this.prisma.revenueSplitConfig.findMany({ orderBy: [{ scope: 'asc' }, { scopeKey: 'asc' }, { effectiveFrom: 'desc' }] });
  }

  async upsert(body: any, actorId: string, roles: RoleName[]) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Body is required');
    const scope = String(body.scope ?? '').toUpperCase();
    const scopeKey = body.scopeKey == null || body.scopeKey === '' ? null : String(body.scopeKey).toUpperCase();
    if (scope !== 'GLOBAL' && scope !== 'COUNTRY') throw new BadRequestException('scope must be GLOBAL or COUNTRY');
    if (scope === 'GLOBAL' && scopeKey !== null) throw new BadRequestException('GLOBAL scope cannot have scopeKey');
    if (scope === 'COUNTRY' && !/^[A-Z]{2}$/.test(scopeKey ?? '')) throw new BadRequestException('COUNTRY scopeKey must be an ISO-2 country code');

    const creatorShareBps = Number(body.creatorShareBps);
    const platformShareBps = Number(body.platformShareBps);
    const agencyShareBps = body.agencyShareBps == null ? 0 : Number(body.agencyShareBps);
    for (const [name, value] of [['creatorShareBps', creatorShareBps], ['platformShareBps', platformShareBps], ['agencyShareBps', agencyShareBps]] as const) {
      if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new BadRequestException(`${name} must be a whole number from 0 to 10000`);
    }
    if (creatorShareBps + platformShareBps !== 10_000) throw new BadRequestException('Creator and platform shares must total 10000 basis points');
    if (agencyShareBps > creatorShareBps) throw new BadRequestException('Agency commission cannot exceed the creator pool');

    if (body.active !== undefined && typeof body.active !== 'boolean') throw new BadRequestException('active must be true or false');
    const data = { scope, scopeKey, creatorShareBps, platformShareBps, agencyShareBps, active: body.active === undefined ? true : body.active };
    const before = await this.prisma.revenueSplitConfig.findFirst({ where: { scope, scopeKey, active: true }, orderBy: { effectiveFrom: 'desc' } });
    const saved = await this.prisma.revenueSplitConfig.create({ data: data as Prisma.RevenueSplitConfigCreateInput });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'revenue_split.create', targetType: 'revenue_split_config', targetId: saved.id, metadata: { before, after: saved } as any });
    return saved;
  }
}
