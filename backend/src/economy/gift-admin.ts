import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export function cleanGiftInput(body: any, creating: boolean) {
  if (!body || typeof body !== 'object') throw new BadRequestException('Body is required');
  const errors: string[] = [];
  const out: { code?: string; name: string; coinPrice: number; icon: string; category: string | null; active: boolean } = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    coinPrice: body.coinPrice,
    icon: typeof body.icon === 'string' ? body.icon.trim() : '',
    category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null,
    active: body.active === undefined ? true : body.active,
  };
  if (creating) {
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9_]{2,20}$/.test(code)) errors.push('code must be 2-20 letters, numbers or _ (it never changes)');
    else out.code = code;
  }
  if (out.name.length < 1 || out.name.length > 30) errors.push('name must be 1 to 30 characters');
  if (!Number.isInteger(out.coinPrice) || out.coinPrice < 1 || out.coinPrice > 1_000_000) errors.push('coinPrice must be a whole number from 1 to 1,000,000');
  if (out.icon.length < 1 || out.icon.length > 12) errors.push('icon must be an emoji (1 to 12 characters)');
  if (out.category && out.category.length > 20) errors.push('category can be at most 20 characters');
  if (typeof out.active !== 'boolean') errors.push('active must be true or false');
  if (errors.length) throw new BadRequestException(errors.join('; '));
  return out;
}

@Injectable()
export class GiftAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.gift.findMany({ orderBy: [{ active: 'desc' }, { coinPrice: 'asc' }] });
  }

  async create(body: unknown, actorId: string, roles: RoleName[]) {
    const data = cleanGiftInput(body, true) as ReturnType<typeof cleanGiftInput> & { code: string };
    if (await this.prisma.gift.findUnique({ where: { code: data.code } })) throw new ConflictException('A gift with that code already exists');
    const gift = await this.prisma.gift.create({ data });
    await this.audit.record({ actorId, actorRole: roles[0], action: 'gift.create', targetType: 'gift', targetId: gift.id, metadata: { code: gift.code, coinPrice: gift.coinPrice } as any });
    return gift;
  }

  // A price change only affects gifts sent from then on: every sent gift keeps the
  // coin amount it was sent at. Gifts are switched off, never deleted, so the
  // history that refers to them stays readable.
  async update(id: string, body: unknown, actorId: string, roles: RoleName[]) {
    const before = await this.prisma.gift.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Gift not found');
    const { code: _ignored, ...data } = cleanGiftInput(body, false) as any;
    const gift = await this.prisma.gift.update({ where: { id }, data });
    await this.audit.record({
      actorId,
      actorRole: roles[0],
      action: 'gift.update',
      targetType: 'gift',
      targetId: id,
      metadata: { before: { name: before.name, coinPrice: before.coinPrice, icon: before.icon, active: before.active }, after: { name: gift.name, coinPrice: gift.coinPrice, icon: gift.icon, active: gift.active } } as any,
    });
    return gift;
  }
}
