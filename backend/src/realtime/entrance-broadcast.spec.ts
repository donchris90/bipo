import { RealtimeGateway } from './realtime.gateway';

function build() {
  const gw = new RealtimeGateway({} as any, {} as any, {} as any, {} as any);
  const emitted: Array<{ room: string; ev: string; payload: any }> = [];
  (gw as any).server = { to: (room: string) => ({ emit: (ev: string, payload: any) => emitted.push({ room, ev, payload }) }) };
  return { gw, emitted };
}

const entrance = (over: Record<string, any> = {}) => ({
  userId: 'u1', displayName: 'Ada', avatarUrl: null, tier: 'VIP 1', level: 2, message: 'Ada entered the live',
  presentation: 2 as const, presentationName: 'VIP' as const, rrydaLevel: 5, supporterLevel: 0, fanClub: false, badgeEmoji: null,
  ...over,
});

describe('RealtimeGateway entrance broadcasts', () => {
  it('a live entrance goes to that live, and a VIP-or-bigger one also leaves a line in chat', () => {
    const { gw, emitted } = build();
    gw.broadcastLiveEntrance('s1', entrance());
    expect(emitted.map((e) => e.ev)).toEqual(['live:vip_entrance', 'chat:message']);
    expect(emitted.every((e) => e.room === 'LIVE:s1')).toBe(true);
    expect(emitted[0].payload).toMatchObject({ presentation: 2, presentationName: 'VIP', level: 2, tier: 'VIP 1' });
    expect(emitted[1].payload).toMatchObject({ system: true, vipEntrance: true, content: 'Ada entered the live' });
  });

  it('the slim WELCOME chip does NOT also spam a chat line', () => {
    const { gw, emitted } = build();
    gw.broadcastLiveEntrance('s1', entrance({ presentation: 1, presentationName: 'WELCOME' }));
    expect(emitted.map((e) => e.ev)).toEqual(['live:vip_entrance']);
  });

  it('a Party room entrance uses the same event to the ROOM channel, with no extra chat line', () => {
    const { gw, emitted } = build();
    gw.broadcastRoomEntrance('r1', entrance({ message: 'Ada entered the room' }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ room: 'ROOM:r1', ev: 'live:vip_entrance' });
  });

  it('the same person re-joining (token refresh, reconnect) does not re-play within 5 minutes', () => {
    const { gw, emitted } = build();
    gw.broadcastRoomEntrance('r1', entrance());
    gw.broadcastRoomEntrance('r1', entrance());
    gw.broadcastRoomEntrance('r1', entrance());
    expect(emitted).toHaveLength(1);
  });

  it('but plays again after the window, and for a different room or a different person', () => {
    const { gw, emitted } = build();
    const g: any = gw;
    expect(g.shouldPlayEntrance('u1', 'ROOM:r1', 1_000)).toBe(true);
    expect(g.shouldPlayEntrance('u1', 'ROOM:r1', 1_000 + 299_999)).toBe(false);
    expect(g.shouldPlayEntrance('u1', 'ROOM:r1', 1_000 + 300_000)).toBe(true);
    expect(g.shouldPlayEntrance('u1', 'ROOM:r2', 1_000)).toBe(true);
    expect(g.shouldPlayEntrance('u2', 'ROOM:r1', 1_000)).toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('live and room entrances for the same person are tracked separately', () => {
    const { gw, emitted } = build();
    gw.broadcastLiveEntrance('x', entrance());
    gw.broadcastRoomEntrance('x', entrance());
    expect(emitted.filter((e) => e.ev === 'live:vip_entrance')).toHaveLength(2);
  });
});
