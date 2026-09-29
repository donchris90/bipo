export interface LudoPrizeSplit { first: number; second: number; platform: number; }
export function calculateLudoPrizeSplit(totalPlayerPool: number, playerCount: 2 | 4): LudoPrizeSplit {
  if (!Number.isInteger(totalPlayerPool) || totalPlayerPool < 0) throw new Error('Invalid Ludo player pool');
  if (playerCount === 2) return { first: totalPlayerPool, second: 0, platform: 0 };
  const first = Math.floor(totalPlayerPool * (2 / 3));
  return { first, second: totalPlayerPool - first, platform: 0 };
}
export function calculateSpectatorPoolSplit(totalSpectatorPool: number) {
  if (!Number.isInteger(totalSpectatorPool) || totalSpectatorPool < 0) throw new Error('Invalid spectator pool');
  const platform = Math.floor(totalSpectatorPool * 0.10);
  const winner = Math.floor(totalSpectatorPool * 0.20);
  return { platform, winner, spectators: totalSpectatorPool - platform - winner };
}
export function calculateWinningSpectatorReward(winningSpectatorPool: number, spectatorStake: number, totalWinningSpectatorStake: number) {
  if (winningSpectatorPool < 0 || spectatorStake < 0 || totalWinningSpectatorStake <= 0 || spectatorStake > totalWinningSpectatorStake) throw new Error('Invalid spectator payout inputs');
  return Math.floor((winningSpectatorPool * spectatorStake) / totalWinningSpectatorStake);
}
