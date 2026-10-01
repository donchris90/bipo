import { PrismaClient, LedgerEntryType, WalletType } from '@prisma/client';
import { WalletService } from '../src/economy/wallet.service';

async function main() {
  const apply = process.argv.slice(2).some((a) => ['apply', '--apply', '--yes', '-y'].includes(a.toLowerCase()));
  const prisma = new PrismaClient();
  const wallet = new WalletService(prisma as any);
  try {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    const rounds = await prisma.gameRound.findMany({
      where: { status: 'RESOLVING', lockAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
    });
    if (rounds.length === 0) {
      console.log('No stuck rounds.');
      return;
    }
    console.log(apply ? 'APPLYING changes.\n' : 'PREVIEW ONLY - nothing is changed. Add the word  apply  to do it.\n');

    let cancelled = 0, refundedEntries = 0, refundedCoins = 0, skipped = 0;
    for (const r of rounds) {
      const entries = await prisma.gameEntry.findMany({ where: { roundId: r.id } });
      const allPlaced = entries.every((e) => e.status === 'PLACED');
      const label = `${r.gameCode} ${r.id}`;

      if (entries.length > 0 && !allPlaced) {
        console.log(`SKIP    ${label}: some entries already decided - check by hand`);
        skipped++;
        continue;
      }
      if (entries.length === 0) {
        console.log(`CANCEL  ${label}: no entries`);
      } else {
        const total = entries.reduce((n, e) => n + e.coinAmount, 0);
        console.log(`REFUND  ${label}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${total} coins staked`);
      }
      if (!apply) continue;

      for (const entry of entries) {
        const bonus = Math.min(entry.bonusAmount, entry.coinAmount);
        const coin = entry.coinAmount - bonus;
        await prisma.$transaction(async (tx) => {
          if (coin > 0) {
            await wallet.credit(
              { userId: entry.userId, walletType: WalletType.COIN, amount: BigInt(coin), ledgerType: LedgerEntryType.REFUND, reference: entry.id, idempotencyKey: `game_refund:${entry.id}` },
              tx as any,
            );
          }
          if (bonus > 0) {
            await wallet.credit(
              { userId: entry.userId, walletType: WalletType.BONUS, amount: BigInt(bonus), ledgerType: LedgerEntryType.REFUND, reference: entry.id, idempotencyKey: `game_refund_bonus:${entry.id}` },
              tx as any,
            );
          }
          await tx.gameEntry.update({ where: { id: entry.id }, data: { status: 'REFUNDED', rewardAmount: 0, netAmount: -entry.coinAmount } });
        }, { timeout: 30000, maxWait: 30000 });
        refundedEntries++;
        refundedCoins += entry.coinAmount;
      }
      await prisma.gameRound.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
      cancelled++;
    }
    console.log(`\n${apply ? 'Done' : 'Would do'}: ${apply ? cancelled : rounds.length - skipped} round(s) cancelled, ${refundedEntries} entr${refundedEntries === 1 ? 'y' : 'ies'} refunded (${refundedCoins} coins), ${skipped} skipped.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
