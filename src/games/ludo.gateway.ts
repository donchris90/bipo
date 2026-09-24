import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { LudoService } from './ludo.service';

interface LudoSocket extends Socket { data: { userId?: string; matchId?: string } }

@WebSocketGateway({ namespace: '/ludo', cors: { origin: '*' } })
export class LudoGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private botTimer: NodeJS.Timeout;
  constructor(private readonly jwt: JwtService, private readonly config: ConfigService, private readonly ludo: LudoService) {
    this.botTimer = setInterval(async () => {
      const states = await this.ludo.tickActiveMatches();
      for (const state of states) this.server?.to(`LUDO:${state.matchId}`).emit('ludo:state', state);
    }, 1000);
  }

  async handleConnection(client: LudoSocket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('No token');
      const payload = await this.jwt.verifyAsync(token, { secret: this.config.get<string>('JWT_ACCESS_SECRET') });
      client.data.userId = payload.sub;
    } catch { client.disconnect(); }
  }

  async handleDisconnect(client: LudoSocket) {
    if (client.data.userId && client.data.matchId) {
      await this.ludo.disconnect(client.data.userId, client.data.matchId);
    }
  }

  @SubscribeMessage('ludo:join')
  async join(@MessageBody() data: { matchId: string }, @ConnectedSocket() client: LudoSocket) {
    if (!client.data.userId) return { error: 'unauthenticated' };
    client.data.matchId = data.matchId;
    client.join(`LUDO:${data.matchId}`);
    const state = await this.ludo.reconnect(client.data.userId, data.matchId);
    this.server.to(`LUDO:${data.matchId}`).emit('ludo:state', state);
    return state;
  }

  @SubscribeMessage('ludo:roll')
  async roll(@ConnectedSocket() client: LudoSocket) {
    if (!client.data.userId || !client.data.matchId) return { error: 'not_joined' };
    const state = await this.ludo.roll(client.data.userId, client.data.matchId);
    this.server.to(`LUDO:${client.data.matchId}`).emit('ludo:state', state);
    return state;
  }

  @SubscribeMessage('ludo:move')
  async move(@MessageBody() data: { tokenIndex: number }, @ConnectedSocket() client: LudoSocket) {
    if (!client.data.userId || !client.data.matchId) return { error: 'not_joined' };
    const state = await this.ludo.move(client.data.userId, client.data.matchId, data.tokenIndex);
    this.server.to(`LUDO:${client.data.matchId}`).emit('ludo:state', state);
    return state;
  }
}
