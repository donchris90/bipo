import { LedgerEntryType, Prisma, WalletType } from '@prisma/client';
import type { WalletService } from '../economy/wallet.service';

// Bonus coins (check-in, missions, referrals) are free play credit. They may be
// staked in games, but nothing they win can leave the bonus wallet — otherwise
// free coins could be turned into spendable coins (gifted to a creator account,
// then withdrawn) by playing. Staking bonus coins on a high multiplier is
// effectively a free bet, worth ~(1 - house edge) of a real coin if the winnings
// were paid out as real coins, so the split must be exact and permanent.

// How a stake was funded: bonus coins first (when the player allows it), then
// normal coins for the remainder.
export function planStake(stake: number, bonusBalance: bigint, useBonus: boolean): { bonus: number; coin: number } {
  const bonus = useBonus ? Number(bonusBalance < BigInt(stake) ? bonusBalance : BigInt(stake)) : 0;
  return { bonus, coin: stake - bonus };
}

// Splits a payout in the same proportion the stake was funded. Integer-exact
// (BigInt, rounded down for the bonus share, the coin share takes the rest) so
// the two parts always add up to the reward and no coin is created or lost.
export function splitReward(reward: number, stake: number, bonusStake: number): { coin: number; bonus: number } {
  if (!(bonusStake > 0) || !(stake > 0)) return { coin: reward, bonus: 0 };
  const bonus = Number((BigInt(reward) * BigInt(Math.min(bonusStake, stake))) / BigInt(stake));
  return { coin: reward - bonus, bonus };
}

// Credits a game reward to the wallets the stake came from. The normal-coin part
// keeps the original idempotency key, so entries placed before bonus staking
// existed (all normal coins) behave exactly as before.
export async function creditGameReward(
  wallet: Pick<WalletService, 'credit'>,
  p: { userId: string; reward: number; coinAmount: number; bonusAmount: number; entryId: string },
  tx: Prisma.TransactionClient,
) {
  const { coin, bonus } = splitReward(p.reward, p.coinAmount, p.bonusAmount);
  if (coin > 0) {
    await wallet.credit(
      { userId: p.userId, walletType: WalletType.COIN, amount: BigInt(coin), ledgerType: LedgerEntryType.GAME_REWARD, reference: p.entryId, idempotencyKey: `game_reward:${p.entryId}` },
      tx,
    );
  }
  if (bonus > 0) {
    await wallet.credit(
      { userId: p.userId, walletType: WalletType.BONUS, amount: BigInt(bonus), ledgerType: LedgerEntryType.GAME_REWARD, reference: p.entryId, idempotencyKey: `game_reward_bonus:${p.entryId}` },
      tx,
    );
  }
}
