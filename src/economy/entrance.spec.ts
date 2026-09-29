import { presentationTier, resolveEntrance, PRESENTATION_NAMES } from './entrance';

describe('presentationTier', () => {
  const t = (gifterLevel: number, supporterLevel = 0, fanClubMember = false) => presentationTier({ gifterLevel, supporterLevel, fanClubMember });

  it('gives an ordinary new user no entrance at all', () => {
    expect(t(0)).toBe(0);
    expect(t(1)).toBe(0); // "Supporter" gifter, but nothing with this creator
  });

  it('maps global gifter levels onto the four looks', () => {
    expect(t(2)).toBe(2); // VIP 1
    expect(t(3)).toBe(2); // VIP 2
    expect(t(4)).toBe(3); // VIP 3
    expect(t(5)).toBe(4); // VIP 4 (1M+ coins)
  });

  it('gives a fan club member a WELCOME chip even with no gifting history', () => {
    expect(t(0, 1, true)).toBe(1);
  });

  it('lets standing with THIS creator earn an entrance the global level would not', () => {
    expect(t(0, 3)).toBe(0); // Bronze supporter: nothing yet
    expect(t(0, 4)).toBe(1); // Silver
    expect(t(0, 7)).toBe(2); // Diamond
    expect(t(0, 9)).toBe(3); // Legendary
    expect(t(0, 10)).toBe(4); // Mythic supporter of this creator = the top moment
  });

  it('never lowers a bigger gifter because of a small supporter level', () => {
    expect(t(5, 1)).toBe(4);
    expect(t(4, 2, true)).toBe(3);
  });

  it('never exceeds 4', () => {
    expect(t(5, 10, true)).toBe(4);
  });

  it('names line up with the numbers', () => {
    expect(PRESENTATION_NAMES).toEqual(['NONE', 'WELCOME', 'VIP', 'ROYAL', 'LEGEND']);
  });
});

function build(opts: { coins?: number; user?: any; bond?: any; badge?: any } = {}) {
  const prisma: any = {
    giftTransaction: { aggregate: async () => ({ _sum: { coinAmount: opts.coins ?? 0 } }) },
    user: {
      findUnique: async () => (opts.user === null ? null : { displayName: 'Ada', avatarUrl: 'https://x/a.png', rrydaLevel: 7, ...(opts.user ?? {}) }),
    },
    creatorSupporter: { findUnique: async () => opts.bond ?? null },
    userBadge: { findMany: async () => (opts.badge ? [{ userId: 'u1', badgeKey: 'EARLY_RRYDA', badge: { emoji: opts.badge, label: 'x', active: true } }] : []) },
  };
  return prisma;
}

describe('resolveEntrance', () => {
  it('returns nothing for the host arriving in their own room', async () => {
    expect(await resolveEntrance(build({ coins: 5_000_000 }), 'host', 'host', 'live')).toBeNull();
  });

  it('returns nothing for someone who qualifies for no entrance', async () => {
    expect(await resolveEntrance(build({ coins: 50 }), 'u1', 'host', 'live')).toBeNull();
  });

  it('returns nothing if the user no longer exists', async () => {
    expect(await resolveEntrance(build({ coins: 5_000_000, user: null }), 'u1', 'host', 'live')).toBeNull();
  });

  it('builds a full VIP payload, keeping the old fields older app builds read', async () => {
    const e = await resolveEntrance(build({ coins: 12_000 }), 'u1', 'host', 'live');
    expect(e).toMatchObject({
      userId: 'u1', displayName: 'Ada', tier: 'VIP 1', level: 2, presentation: 2, presentationName: 'VIP', rrydaLevel: 7,
      message: 'Ada entered the live',
    });
  });

  it('words the message for a Party room', async () => {
    const e = await resolveEntrance(build({ coins: 12_000 }), 'u1', 'host', 'room');
    expect(e!.message).toBe('Ada entered the room');
  });

  it('a Mythic supporter of THIS creator gets the LEGEND entrance with almost no gifting elsewhere', async () => {
    const e = await resolveEntrance(build({ coins: 10, bond: { level: 10, fanClubJoinedAt: new Date() } }), 'u1', 'host', 'room');
    expect(e).toMatchObject({ presentation: 4, presentationName: 'LEGEND', supporterLevel: 10, fanClub: true });
  });

  it('labels a fan-club-only arrival sensibly instead of "New Gifter"', async () => {
    const e = await resolveEntrance(build({ coins: 0, bond: { level: 1, fanClubJoinedAt: new Date() } }), 'u1', 'host', 'live');
    expect(e).toMatchObject({ presentation: 1, tier: 'Fan Club', fanClub: true });
  });

  it('includes their best badge emoji when they have one', async () => {
    const e = await resolveEntrance(build({ coins: 12_000, badge: '💎' }), 'u1', 'host', 'live');
    expect(e!.badgeEmoji).toBe('💎');
  });

  it('still resolves if the badge lookup fails', async () => {
    const prisma = build({ coins: 12_000 });
    prisma.userBadge.findMany = async () => { throw new Error('db hiccup'); };
    const e = await resolveEntrance(prisma, 'u1', 'host', 'live');
    expect(e).toMatchObject({ presentation: 2, badgeEmoji: null });
  });
});
