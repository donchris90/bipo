// Add coins to one person's wallet.
//
//   npm run admin:coins -- ada@example.com 500                    (preview only)
//   npm run admin:coins -- ada@example.com 500 apply              (do it)
//   npm run admin:coins -- ada@example.com 500 apply note=support gift
//   npm run admin:coins -- ada@example.com 200 bonus apply        (game-only bonus coins)
//
// (`--yes` and `--note "..."` also work when run directly, but npm on Windows can
// swallow them, so the plain words above are the safe way.)
// Runs against whatever database DATABASE_URL in .env points at. The person must
// already have registered.
import { PrismaClient } from '@prisma/client';
import { grantCoins, parseGrantArgs } from '../src/admin/grant-coins';

async function main() {
  const input = parseGrantArgs(process.argv.slice(2));

  const prisma = new PrismaClient();
  try {
    const r = await grantCoins(prisma, input);
    const who = `${r.user.email}${r.user.displayName ? ` (${r.user.displayName})` : ''}`;
    if (!r.applied) {
      console.log(`PREVIEW — nothing changed.\n${who}\n${r.walletType} wallet: ${r.before} -> ${r.after}\nRun it again with the word  apply  at the end to add the coins.`);
    } else {
      console.log(`Done. ${who}\n${r.walletType} wallet: ${r.before} -> ${r.after}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
