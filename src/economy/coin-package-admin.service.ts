import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class CoinPackageAdminService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(countryCode?: string) {
    return this.prisma.coinPackage.findMany({
      where: countryCode ? { countryCode: countryCode.toUpperCase() } : undefined,
      orderBy: [{ countryCode: 'asc' }, { coinAmount: 'asc' }],
    });
  }

  async upsert(id: string | undefined, body: any, actorId: string, actorRoles: RoleName[]) {
    const countryCode = String(body.countryCode ?? '').toUpperCase();
    const coinAmount = Number(body.coinAmount);
    const priceMinor = Number(body.priceMinor);
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new BadRequestException('countryCode must be an ISO-2 country code');
    if (!Number.isInteger(coinAmount) || coinAmount <= 0) throw new BadRequestException('coinAmount must be a positive whole number');
    if (!Number.isInteger(priceMinor) || priceMinor <= 0) throw new BadRequestException('priceMinor must be a positive whole number');
    const region = await this.prisma.regionalConfig.findUnique({ where: { countryCode } });
    if (!region) throw new NotFoundException('Country is not configured');
    const active = body.active === undefined ? true : Boolean(body.active);
    const data = { countryCode, currencyCode: region.currencyCode, coinAmount, priceMinor, active };
    const before = id ? await this.prisma.coinPackage.findUnique({ where: { id } }) : null;
    const saved = id
      ? await this.prisma.coinPackage.update({ where: { id }, data })
      : await this.prisma.coinPackage.create({ data });
    await this.audit.record({ actorId, actorRole: actorRoles[0], action: id ? 'coin_package.update' : 'coin_package.create', targetType: 'coin_package', targetId: saved.id, metadata: { before, after: saved } as any });
    return saved;
  }

  async setActive(id: string, active: boolean, actorId: string, actorRoles: RoleName[]) {
    const before = await this.prisma.coinPackage.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Coin package not found');
    const saved = await this.prisma.coinPackage.update({ where: { id }, data: { active } });
    await this.audit.record({ actorId, actorRole: actorRoles[0], action: 'coin_package.status', targetType: 'coin_package', targetId: id, metadata: { before, after: saved } as any });
    return saved;
  }
}
