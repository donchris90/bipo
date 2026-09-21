import { RealtimeGateway } from './realtime.gateway';

function build(opts: { banned?: boolean; nameLookup?: () => Promise<any> } = {}) {
  const prisma: any = { user: { findUnique: opts.nameLookup ?? jest.fn().mockResolvedValue({ displayName: '  Ada  ' }) } };
  const moderation: any = { isBanned: jest.fn().mockResolvedValue(!!opts.banned) };
  const gw = new RealtimeGateway({} as any, {} as any, prisma, moderation);
  const emitted: any[] = [];
  const rooms: string[] = [];
  const client: any = {
    data: { userId: 'u1' },
    join: (r: string) => rooms.push(r),
    to: (r: string) => ({ emit: (ev: string, payload: any) => emitted.push({ room: r, ev, payload }) }),
  };
  return { gw, client, emitted, rooms };
}

describe('"X joined" notice in the chat', () => {
  it("tells everyone already in a live stream or room, as a system line — not the joiner", async () => {
    const { gw, client, emitted, rooms } = build();
    expect(await gw.handleJoin({ context: 'LIVE', contextId: 's1' }, client)).toEqual({ joined: true });
    expect(rooms).toEqual(['LIVE:s1']);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ room: 'LIVE:s1', ev: 'chat:message' });
    expect(emitted[0].payload).toMatchObject({ senderId: 'system', system: true, content: 'Ada joined' });
    const room = build();
    await room.gw.handleJoin({ context: 'ROOM', contextId: 'r1' }, room.client);
    expect(room.emitted[0].payload.content).toBe('Ada joined');
  });

  it('posts nothing for other channels (PK) and nothing for a banned user', async () => {
    const pk = build();
    await pk.gw.handleJoin({ context: 'pk' as any, contextId: 'b1' }, pk.client);
    expect(pk.emitted).toHaveLength(0);
    const banned = build({ banned: true });
    expect(await banned.gw.handleJoin({ context: 'LIVE', contextId: 's1' }, banned.client)).toEqual({ error: 'banned' });
    expect(banned.emitted).toHaveLength(0);
  });

  it('a reconnect within 30 seconds does not post the same person again', async () => {
    const { gw, client, emitted } = build();
    await gw.handleJoin({ context: 'LIVE', contextId: 's1' }, client);
    await gw.handleJoin({ context: 'LIVE', contextId: 's1' }, client);
    await gw.handleJoin({ context: 'LIVE', contextId: 's1' }, client);
    expect(emitted).toHaveLength(1);
    // ...but the same person joining a different stream is announced there
    await gw.handleJoin({ context: 'LIVE', contextId: 's2' }, client);
    expect(emitted).toHaveLength(2);
    // ...and after the window they are announced again
    (gw as any).lastJoinNotice.set('u1|LIVE:s1', Date.now() - 31_000);
    await gw.handleJoin({ context: 'LIVE', contextId: 's1' }, client);
    expect(emitted).toHaveLength(3);
  });

  it('a person with no display name shows as "Someone", and a failed name lookup never blocks joining', async () => {
    const anon = build({ nameLookup: async () => ({ displayName: null }) });
    await anon.gw.handleJoin({ context: 'LIVE', contextId: 's1' }, anon.client);
    expect(anon.emitted[0].payload.content).toBe('Someone joined');
    const broken = build({ nameLookup: async () => { throw new Error('db'); } });
    expect(await broken.gw.handleJoin({ context: 'LIVE', contextId: 's1' }, broken.client)).toEqual({ joined: true });
    expect(broken.rooms).toEqual(['LIVE:s1']);
  });
});
