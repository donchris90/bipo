import { SocialService } from './social.service';

describe('SocialService.getStats', () => {
  const build = (counts: { follow: number[]; pkWin: number; pkLoss: number }) => {
    const follow = { count: jest.fn().mockResolvedValueOnce(counts.follow[0]).mockResolvedValueOnce(counts.follow[1]) };
    const pKBattle = {
      count: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.winnerId === 'u1' ? counts.pkWin : counts.pkLoss)),
    };
    return { svc: new SocialService({ follow, pKBattle } as any, {} as any, {} as any), pKBattle };
  };

  it('reports followers, following, wins and losses', async () => {
    const { svc } = build({ follow: [3, 9], pkWin: 5, pkLoss: 2 });
    expect(await svc.getStats('u1')).toEqual({ following: 3, followers: 9, pkWins: 5, pkLosses: 2 });
  });

  it('counts a loss only for a settled battle the user played in and did not win (a draw is neither)', async () => {
    const { svc, pKBattle } = build({ follow: [0, 0], pkWin: 0, pkLoss: 0 });
    await svc.getStats('u1');
    const lossQuery = pKBattle.count.mock.calls.map((c: any) => c[0].where).find((w: any) => w.status === 'SETTLED');
    expect(lossQuery.OR).toEqual([{ challengerId: 'u1' }, { opponentId: 'u1' }]);
    expect(lossQuery.AND).toEqual([{ winnerId: { not: null } }, { winnerId: { not: 'u1' } }]);
  });
});
