import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect, WsException } from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { LudoService } from './ludo.service';

interface LudoSocket extends Socket { data: { userId?: string; matchId?: string } }

// Game errors ("Not your turn", ...) reach the app as a readable message instead of "Internal server error".
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) { throw new WsException(e?.response?.message ?? e?.message ?? 'Action not allowed'); }
}

@WebSocketGateway({ namespace: '/ludo', cors: { origin: '*' }, pingInterval: 10_000, pingTimeout: 8_000 })
export class LudoGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private botTimer: NodeJS.Timeout;
  private ticking = false;
  constructor(private readonly jwt: JwtService, private readonly config: ConfigService, private readonly ludo: LudoService) {
    // The AI's heartbeat: every second it checks whose turn has run out and plays for bots and absent players.
    this.botTimer = setInterval(async () => {
      if (this.ticking) return; // never let slow ticks pile up
      this.ticking = true;
      try {
        const states = await this.ludo.tickActiveMatches();
        for (const state of states) this.server?.to(`LUDO:${state.matchId}`).emit('ludo:state', state);
      } catch { /* try again next second */ } finally { this.ticking = false; }
    }, 1000);
  }

  onModuleDestroy() { clearInterval(this.botTimer); }

  async handleConnection(client: LudoSocket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('No token');
      const payload = await this.jwt.verifyAsync(token, { secret: this.config.get<string>('JWT_ACCESS_SECRET') });
      client.data.userId = payload.sub;
    } catch { client.disconnect(); }
  }

  async handleDisconnect(client: LudoSocket) {
    const { userId, matchId } = client.data;
    if (!userId || !matchId) return;
    // A phone that reconnects opens the new socket before the old one is reported dead. Only a player with
    // NO socket left in the match counts as away.
    const room = `LUDO:${matchId}`;
    const stillHere = (await this.server.in(room).fetchSockets()).some(s => s.id !== client.id && (s.data as any)?.userId === userId);
    if (stillHere) return;
    const state = await this.ludo.disconnect(userId, matchId).catch(() => undefined);
    if (state) this.server.to(room).emit('ludo:state', state);
  }

  @SubscribeMessage('ludo:join')
  async join(@MessageBody() data: { matchId: string }, @ConnectedSocket() client: LudoSocket) {
    if (!client.data.userId) return { error: 'unauthenticated' };
    return guard(async () => {
      const state = await this.ludo.reconnect(client.data.userId!, data.matchId); // also checks the player belongs to the match
      client.data.matchId = data.matchId;
      client.join(`LUDO:${data.matchId}`);
      this.server.to(`LUDO:${data.matchId}`).emit('ludo:state', state);
      return state;
    });
  }

  /** "I'm back": take the seat back from the AI right away. */
  @SubscribeMessage('ludo:resume')
  async resume(@ConnectedSocket() client: LudoSocket) {
    if (!client.data.userId || !client.data.matchId) return { error: 'not_joined' };
    return guard(async () => {
      const state = await this.ludo.resume(client.data.userId!, client.data.matchId!);
      this.server.to(`LUDO:${client.data.matchId}`).emit('ludo:state', state);
      return state;
    });
  }

  @SubscribeMessage('ludo:roll')
  async roll(@ConnectedSocket() client: LudoSocket) {
    if (!client.data.userId || !client.data.matchId) return { error: 'not_joined' };
    return guard(async () => {
      const state = await this.ludo.roll(client.data.userId!, client.data.matchId!);
      this.server.to(`LUDO:${client.data.matchId}`).emit('ludo:state', state);
      return state;
    });
  }

  @SubscribeMessage('ludo:move')
  async move(@MessageBody() data: { tokenIndex: number }, @ConnectedSocket() client: LudoSocket) {
    if (!client.data.userId || !client.data.matchId) return { error: 'not_joined' };
    return guard(async () => {
      const state = await this.ludo.move(client.data.userId!, client.data.matchId!, Number(data?.tokenIndex));
      this.server.to(`LUDO:${client.data.matchId}`).emit('ludo:state', state);
      return state;
    });
  }
}
