export interface GameConfig {
  /** Return to player, e.g. 0.95 for 95%. */
  rtp: number;
  /** Base prize used to derive suggested per-number stakes. */
  basePrize: number;
  /** Hard cap on any single number's multiplier. */
  multiplierCap: number;
  /** Minimum allowed total stake for a bet. */
  minTotalStake: number;
  /** Maximum allowed total stake for a bet. */
  maxTotalStake: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  rtp: 0.95,
  basePrize: 1000,
  multiplierCap: 1000,
  minTotalStake: 1,
  maxTotalStake: 1_000_000,
};

/** Map from picked number (0-27) to stake in whole coins. */
export type StakeMap = Record<number, number>;

export interface SuggestStakesRequest {
  picks: number[];
  /** Optional total the player wants to bet; suggested stakes are scaled to hit it. */
  desiredTotal?: number;
}

export interface SuggestStakesResponse {
  picks: number[];
  stakes: StakeMap;
  multipliers: Record<number, number>;
  /** Sum of stakes before any player-driven scaling. */
  suggestedTotal: number;
  /** Sum of stakes actually returned (equals suggestedTotal unless desiredTotal was given). */
  total: number;
  /** Prize paid for each picked number if it hits, i.e. stake(n) * multiplier(n). */
  prizeIfHit: Record<number, number>;
}

export interface PlaceBetRequest {
  picks: number[];
  stakes: StakeMap;
  /** Client-supplied idempotency key. Re-submitting the same key returns the original result. */
  idempotencyKey: string;
}

export interface BetResult {
  betId: string;
  idempotencyKey: string;
  picks: number[];
  stakes: StakeMap;
  totalStake: number;
  digits: [number, number, number];
  result: number;
  won: boolean;
  payout: number;
  net: number;
  settledAt: number;
  /** True if this response was served from the idempotency cache rather than freshly settled. */
  replayed: boolean;
}
