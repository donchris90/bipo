/** Canonical public round data used by the commit/reveal system. */
export function buildRoundData(round: {
  gameCode: string;
  openAt: Date;
  lockAt: Date;
  numberRange: number | null;
}): string {
  return JSON.stringify({
    gameCode: round.gameCode,
    openAt: round.openAt,
    lockAt: round.lockAt,
    numberRange: round.numberRange,
  });
}
