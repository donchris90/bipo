import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const rounds = await prisma.gameRound.findMany({
      where: { status: 'RESOLVING' },
      orderBy: { createdAt: 'asc' },
    });
    if (rounds.length === 0) {
      console.log('No rounds are stuck in RESOLVING.');
      return;
    }
    console.log(`${rounds.length} round(s) stuck in RESOLVING:\n`);
    for (const r of rounds) {
      const entries = await prisma.gameEntry.groupBy({
        by: ['status'],
        where: { roundId: r.id },
        _count: { _all: true },
        _sum: { coinAmount: true, rewardAmount: true },
      });
      const total = entries.reduce((n, e) => n + e._count._all, 0);
      const placed = entries.find((e) => e.status === 'PLACED')?._count._all ?? 0;
      const verdict =
        total === 0 ? 'no entries (nothing to pay)'
        : placed === total ? 'NOTHING PAID YET (all entries still PLACED)'
        : placed === 0 ? 'ALL entries already decided (paid or lost)'
        : 'PARTLY PAID (mixed) - needs care';
      console.log(`${r.gameCode}  ${r.id}  created ${r.createdAt.toISOString()}`);
      console.log(`  ${verdict}`);
      for (const e of entries) {
        console.log(`  ${e.status.padEnd(9)} entries=${e._count._all}  staked=${e._sum.coinAmount ?? 0}  rewards=${e._sum.rewardAmount ?? 0}`);
      }
      console.log('');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
