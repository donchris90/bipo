import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, WsException } from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AyoService } from './ayo.service';

interface AyoSocket extends Socket { data: { userId?: string; matchId?: string; spectator?: boolean } }

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) { throw new WsException(e?.response?.message ?? e?.message ?? 'Ayo action not allowed'); }
}

@WebSocketGateway({ namespace: '/ayo', cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 8000 })
export class AyoGateway implements OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private timer: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly ayo: AyoService,
  ) {
    this.timer = setInterval(async () => {
      // Never let slow ticks pile up. Overlapping ticks each grabbed DB connections and starved
      // the pool, so the quick-match HTTP request hung on "Starting…" until it timed out.
      if (this.ticking) return;
      this.ticking = true;
      try { await this.ayo.tick(); } catch { /* next tick */ } finally { this.ticking = false; }
    }, 1000);
  }

  onModuleDestroy() { clearInterval(this.timer); }

  async handleConnection(client: AyoSocket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('No token');
      const payload = await this.jwt.verifyAsync(token, { secret: this.config.get<string>('JWT_ACCESS_SECRET') });
      client.data.userId = payload.sub;
    } catch { client.disconnect(); }
  }

  async handleDisconnect(client: AyoSocket) {
    if (client.data.userId && client.data.matchId && !client.data.spectator) {
      await this.ayo.setConnection(client.data.userId, client.data.matchId, false).catch(() => undefined);
    }
  }

  @SubscribeMessage('ayo:watch')
  async watch(@MessageBody() data: { matchId: string }, @ConnectedSocket() client: AyoSocket) {
    if (!client.data.userId) return { error: 'unauthenticated' };
    if (!data?.matchId) return { error: 'matchId required' };
    client.data.matchId = data.matchId;
    client.data.spectator = true;
    client.join(`AYO:${data.matchId}`);
    // A table that is still waiting for its second player has no state yet. Stay subscribed so
    // the full state is pushed the moment it starts instead of throwing and leaving the client deaf.
    const state = await this.ayo.getState(data.matchId).catch(() => null);
    if (state) client.emit('ayo:state', state);
    return state ?? { status: 'WAITING', matchId: data.matchId };
  }

  @SubscribeMessage('ayo:join')
  async join(@MessageBody() data: { matchId: string }, @ConnectedSocket() client: AyoSocket) {
    const userId = client.data.userId;
    if (!userId) return { error: 'unauthenticated' };
    if (!data?.matchId) return { error: 'matchId required' };
    return guard(async () => {
      const state = await this.ayo.getState(data.matchId).catch(() => null);
      if (!state) {
        // Room creator connects before an opponent arrives: subscribe now, and the server pushes
        // the full state from startMatch(). Moves stay impossible until the state exists and
        // AyoService.move() re-checks that this user is the seated player.
        client.data.matchId = data.matchId;
        client.data.spectator = false;
        client.join(`AYO:${data.matchId}`);
        return { status: 'WAITING', matchId: data.matchId };
      }
      if (!state.players.some(p => p.userId === userId)) throw new WsException('You are not a player in this match');
      client.data.matchId = data.matchId;
      client.data.spectator = false;
      client.join(`AYO:${data.matchId}`);
      const fresh = (await this.ayo.setConnection(userId, data.matchId, true)) ?? state;
      const out = { ...fresh, serverNow: Date.now() };
      client.emit('ayo:state', out);
      return out;
    });
  }

  @SubscribeMessage('ayo:move')
  async move(@MessageBody() data: { pit: number; matchId?: string }, @ConnectedSocket() client: AyoSocket) {
    if (!client.data.userId) return { error: 'unauthenticated' };
    // Accept the matchId on the move itself so a socket that reconnected (and lost its join
    // binding for a moment) can still play instead of silently returning not_joined.
    const matchId = client.data.matchId ?? data?.matchId;
    if (!matchId || client.data.spectator) return { error: 'Not joined to this match. Reconnecting…' };
    try {
      const state = await this.ayo.move(client.data.userId, matchId, Number(data?.pit));
      return { ok: true, state };
    } catch (e: any) {
      return { error: e?.response?.message ?? e?.message ?? 'That move is not allowed.' };
    }
  }
}
