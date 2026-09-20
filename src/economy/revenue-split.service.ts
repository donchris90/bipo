import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ResolvedSplit {
  creatorShareBps: number;
  platformShareBps: number;
  agencyShareBps: number;
}

const FALLBACK_SPLIT: ResolvedSplit = {
  // Only used if no config row exists at all (e.g. fresh install before an
  // admin has set anything). Production should always have a GLOBAL row.
  creatorShareBps: 7000,
  platformShareBps: 3000,
  agencyShareBps: 0,
};

@Injectable()
export class RevenueSplitService {
  constructor(private readonly prisma: PrismaService) {}

  // Resolution order: COUNTRY-scoped config for this user's country, else
  // GLOBAL, else the hard fallback above. Creator-program-scoped overrides
  // (spec §24) can be added the same way once creator programs exist.
  async resolve(countryCode: string): Promise<ResolvedSplit> {
    const country = await this.prisma.revenueSplitConfig.findFirst({
      where: { scope: 'COUNTRY', scopeKey: countryCode, active: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (country) return country;

    const global = await this.prisma.revenueSplitConfig.findFirst({
      where: { scope: 'GLOBAL', active: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (global) return global;

    return FALLBACK_SPLIT;
  }
}
