import { EntryService } from './entry.service';
import { creditGameReward, planStake, splitReward } from './game-payout';

describe('planStake', () => {
  it('uses bonus coins first, then normal coins for the rest', () => {
    expect(planStake(100, 30n, true)).toEqual({ bonus: 30, coin: 70 });
    expect(planStake(100, 500n, true)).toEqual({ bonus: 100, coin: 0 });
    expect(planStake(100, 0n, true)).toEqual({ bonus: 0, coin: 100 });
  });
  it('uses only normal coins when the player opts out of bonus', () => {
    expect(planStake(100, 500n, false)).toEqual({ bonus: 0, coin: 100 });
  });
});

describe('splitReward', () => {
  it('pays winnings back in the proportion the stake was funded', () => {
    expect(splitReward(900, 100, 30)).toEqual({ coin: 630, bonus: 270 });
    expect(splitReward(900, 100, 0)).toEqual({ coin: 900, bonus: 0 });
  });

  it('a stake paid entirely with bonus coins pays NOTHING to normal coins — the anti-laundering rule', () => {
    expect(splitReward(970, 100, 100)).toEqual({ coin: 0, bonus: 970 });
    expect(splitReward(1_000_000, 500, 500).coin).toBe(0);
  });

  it('never creates or loses a coin to rounding', () => {
    for (const [reward, stake, bonus] of [[7, 3, 1], [1001, 7, 2], [9, 10, 3], [123456789, 977, 400], [2_000_000_000, 999_999_999, 333_333_333]] as const) {
      const s = splitReward(reward, stake, bonus);
      expect(s.coin + s.bonus).toBe(reward);
      expect(s.bonus).toBeGreaterThanOrEqual(0);
      expect(s.coin).toBeGreaterThanOrEqual(0);
    }
  });

  it('cannot be tricked by a bonus amount larger than the stake', () => {
    expect(splitReward(200, 100, 500)).toEqual({ coin: 0, bonus: 200 });
  });
});

describe('creditGameReward', () => {
  const build = () => {
    const credit = jest.fn();
    return { wallet: { credit } as any, credit };
  };
  const base = { userId: 'u', entryId: 'e1', reward: 900, coinAmount: 100 };

  it('credits each wallet its share, the normal-coin part under the ORIGINAL key so older entries are unchanged', async () => {
    const { wallet, credit } = build();
    await creditGameReward(wallet, { ...base, bonusAmount: 30 }, {} as any);
    const byWallet = Object.fromEntries(credit.mock.calls.map(([c]: any) => [c.walletType, c]));
    expect(byWallet.COIN).toMatchObject({ amount: 630n, idempotencyKey: 'game_reward:e1' });
    expect(byWallet.BONUS).toMatchObject({ amount: 270n, idempotencyKey: 'game_reward_bonus:e1' });
  });

  it('an all-bonus win touches only the bonus wallet', async () => {
    const { wallet, credit } = build();
    await creditGameReward(wallet, { ...base, bonusAmount: 100 }, {} as any);
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit.mock.calls[0][0].walletType).toBe('BONUS');
  });

  it('an all-normal-coin win behaves exactly as before bonus staking existed', async () => {
    const { wallet, credit } = build();
    await creditGameReward(wallet, { ...base, bonusAmount: 0 }, {} as any);
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit.mock.calls[0][0]).toMatchObject({ walletType: 'COIN', amount: 900n, idempotencyKey: 'game_reward:e1' });
  });
});

describe('EntryService.place funding', () => {
  const build = (bonus: bigint) => {
    const debit = jest.fn();
    const created: any[] = [];
    const tx = { gameEntry: { create: jest.fn(async ({ data }: any) => { created.push(data); return data; }) } };
    const prisma: any = {
      gameEntry: { findUnique: jest.fn().mockResolvedValue(null) },
      gameRound: { findUnique: jest.fn().mockResolvedValue({ id: 'r1', gameCode: 'CRASH', selectionCount: null, numberRange: null, entryPrice: 10 }) },
      gameDefinition: { findUnique: jest.fn().mockResolvedValue({ rulesJson: {} }) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const wallet: any = { debit, getBalance: jest.fn().mockResolvedValue(bonus) };
    const rounds: any = { assertGameAvailable: jest.fn(), assertAcceptingEntries: jest.fn() };
    return { svc: new EntryService(prisma, wallet, rounds), debit, created };
  };
  const place = (svc: EntryService, extra: any = {}) => svc.place({ userId: 'u', countryCode: 'NG', roundId: 'r1', selection: [], stakeAmount: 100, idempotencyKey: 'k', ...extra });

  it('stakes bonus coins first and records how much of the entry was bonus', async () => {
    const { svc, debit, created } = build(30n);
    await place(svc);
    expect(debit.mock.calls.map(([d]: any) => [d.walletType, d.amount])).toEqual([['BONUS', 30n], ['COIN', 70n]]);
    expect(created[0]).toMatchObject({ coinAmount: 100, bonusAmount: 30 });
  });

  it('can be told not to use bonus coins', async () => {
    const { svc, debit, created } = build(500n);
    await place(svc, { useBonus: false });
    expect(debit.mock.calls.map(([d]: any) => d.walletType)).toEqual(['COIN']);
    expect(created[0].bonusAmount).toBe(0);
  });

  it('a stake fully covered by bonus never touches the normal-coin wallet', async () => {
    const { svc, debit } = build(500n);
    await place(svc);
    expect(debit.mock.calls.map(([d]: any) => d.walletType)).toEqual(['BONUS']);
  });
});
