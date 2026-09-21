// Add coins to one person's wallet.
//
//   npm run admin:coins -- ada@example.com 500                 (preview only)
//   npm run admin:coins -- ada@example.com 500 --yes           (do it)
//   npm run admin:coins -- ada@example.com 500 --yes --note "test account"
//   npm run admin:coins -- ada@example.com 200 --bonus --yes   (game-only bonus coins)
//
// Runs against whatever database DATABASE_URL in .env points at (your Render database
// when you use its external URL). The person must already have registered.
import { PrismaClient } from '@prisma/client';
import { grantCoins } from '../src/admin/grant-coins';

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const noteAt = args.indexOf('--note');
  const note = noteAt >= 0 ? args[noteAt + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && !(noteAt >= 0 && i === noteAt + 1));
  const [email, amountText] = positional;
  const amount = Number(amountText);
  if (!email || !amountText) {
    console.error('Usage: npm run admin:coins -- <email> <amount> [--bonus] [--note "text"] [--yes]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const r = await grantCoins(prisma, { email, amount, wallet: flag('--bonus') ? 'BONUS' : 'COIN', note, apply: flag('--yes') });
    const who = `${r.user.email}${r.user.displayName ? ` (${r.user.displayName})` : ''}`;
    if (!r.applied) {
      console.log(`PREVIEW — nothing changed.\n${who}\n${r.walletType} wallet: ${r.before} -> ${r.after}\nRun it again with --yes to add the coins.`);
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
