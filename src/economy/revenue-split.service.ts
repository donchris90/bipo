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
    if (country) return this.validate(country);

    const global = await this.prisma.revenueSplitConfig.findFirst({
      where: { scope: 'GLOBAL', active: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (global) return this.validate(global);

    return FALLBACK_SPLIT;
  }

  private validate(split: ResolvedSplit): ResolvedSplit {
    const values = [split.creatorShareBps, split.platformShareBps, split.agencyShareBps];
    if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 10_000)) {
      throw new Error('Invalid revenue split configuration');
    }
    // agencyShareBps is retained as configuration metadata for future
    // program-level rules; GiftService currently applies the agency's
    // membership commission from the creator pool. The two primary shares
    // must still account for the entire gift.
    if (split.creatorShareBps + split.platformShareBps !== 10_000) {
      throw new Error('Creator and platform shares must total 100%');
    }
    return split;
  }
}
