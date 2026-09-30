import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnModuleDestroy, WsException } from '@nestjs/websockets';
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

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly ayo: AyoService,
  ) {
    this.timer = setInterval(async () => {
      try { await this.ayo.tick(); } catch { /* next tick */ }
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
    return guard(async () => {
      const state = await this.ayo.getState(data.matchId);
      client.data.matchId = data.matchId;
      client.data.spectator = true;
      client.join(`AYO:${data.matchId}`);
      client.emit('ayo:state', state);
      return state;
    });
  }

  @SubscribeMessage('ayo:join')
  async join(@MessageBody() data: { matchId: string }, @ConnectedSocket() client: AyoSocket) {
    if (!client.data.userId) return { error: 'unauthenticated' };
    return guard(async () => {
      const state = await this.ayo.getState(data.matchId);
      if (!state.players.some(p => p.userId === client.data.userId)) throw new WsException('You are not a player in this match');
      client.data.matchId = data.matchId;
      client.data.spectator = false;
      await this.ayo.setConnection(client.data.userId, data.matchId, true);
      client.join(`AYO:${data.matchId}`);
      client.emit('ayo:state', state);
      return state;
    });
  }

  @SubscribeMessage('ayo:move')
  async move(@MessageBody() data: { pit: number }, @ConnectedSocket() client: AyoSocket) {
    if (!client.data.userId || !client.data.matchId || client.data.spectator) return { error: 'not_joined' };
    return guard(() => this.ayo.move(client.data.userId!, client.data.matchId!, Number(data?.pit)));
  }
}
