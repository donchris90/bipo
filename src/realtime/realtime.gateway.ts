import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';
import { ChatContext } from '@prisma/client';
import { isBlockedEitherWay } from '../common/blocks';

interface AuthedSocket extends Socket {
  data: { userId?: string };
}

// Channel naming follows spec §66: live:{sessionId}, room:{roomId}.
// Reconnection (spec §67): the client disconnects/reconnects and re-joins
// the channel; this gateway does not replay financial events on reconnect —
// REST endpoints (GET /live, GET /rooms) are the source of truth for
// current state, sockets only carry the live delta from "now".
@WebSocketGateway({ cors: { origin: '*' } }) // tighten origin allowlist before production
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  // Simple in-memory rate limiter: userId -> timestamps of recent messages.
  // Fine for a single-instance dev setup; move to Redis-backed limiting
  // once this runs across multiple backend instances.
  private messageTimestamps = new Map<string, number[]>();
  private readonly RATE_LIMIT_WINDOW_MS = 10_000;
  private readonly RATE_LIMIT_MAX = 15;

  // Typing indicators are cheap but chatty (a client re-sends while the
  // user keeps typing), so they get their own, looser limiter.
  private typingTimestamps = new Map<string, number[]>();
  private readonly TYPING_WINDOW_MS = 10_000;
  private readonly TYPING_MAX = 20;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('No token');
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
      client.data.userId = payload.sub;
      // Every authenticated socket joins its own personal room — this is
      // what makes "emit directly to this specific user, wherever they
      // are in the app" possible at all. Before this, the gateway could
      // only broadcast to a room/live *context* someone had explicitly
      // joined; there was no way to reach a user who hadn't joined
      // anything yet, which is exactly what an incoming call needs.
      client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthedSocket) {
    if (client.data.userId) {
      this.messageTimestamps.delete(client.data.userId);
      this.typingTimestamps.delete(client.data.userId);
    }
  }

  // A phone that loses signal reconnects and re-joins; without this each reconnect
  // would post another "Ada joined" line and crowd the chat. One notice per person
  // per room per 30 seconds.
  private readonly lastJoinNotice = new Map<string, number>();
  private shouldAnnounceJoin(userId: string, room: string, now = Date.now()): boolean {
    const key = `${userId}|${room}`;
    const last = this.lastJoinNotice.get(key);
    if (last !== undefined && now - last < 30_000) return false;
    this.lastJoinNotice.set(key, now);
    if (this.lastJoinNotice.size > 5000) for (const [k, t] of this.lastJoinNotice) if (now - t > 30_000) this.lastJoinNotice.delete(k);
    return true;
  }

  @SubscribeMessage('join')
  async handleJoin(
    @MessageBody() data: { context: ChatContext; contextId: string },
    @ConnectedSocket() client: AuthedSocket,
  ) {
    const userId = client.data.userId;
    if (!userId) return { error: 'unauthenticated' };
    // A banned user must not be able to (re)enter the socket room and keep
    // receiving the room's chat/gift/moderation events just because they
    // skipped the REST join. Only ROOM/LIVE have a moderation log — other
    // channels (e.g. 'pk') reuse this handler with a free-form context, and
    // passing those to the enum-typed moderation query would throw.
    if (
      (data.context === 'ROOM' || data.context === 'LIVE') &&
      (await this.moderation.isBanned(data.context, data.contextId, userId))
    ) {
      return { error: 'banned' };
    }
    client.join(`${data.context}:${data.contextId}`);

    // Let everyone already watching know someone new just arrived — a
    // system line in the same chat feed, e.g. "Ada joined" (spec: the host
    // should be notified of new joiners in the comment section). Sent to
    // the room only (not back to the joiner — they don't need to see their
    // own arrival), and never persisted to chat history: it's a
    // here-and-now arrival notice, not something someone joining later
    // needs played back. Only LIVE/ROOM have an actual chat feed for this
    // to appear in — 'pk' and other free-form contexts reuse this handler
    // too but have nowhere to show it.
    if ((data.context === 'ROOM' || data.context === 'LIVE') && this.shouldAnnounceJoin(userId, `${data.context}:${data.contextId}`)) {
      try {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
        client.to(`${data.context}:${data.contextId}`).emit('chat:message', {
          id: `join:${userId}:${Date.now()}`,
          senderId: 'system',
          senderName: null,
          content: `${user?.displayName?.trim() || 'Someone'} joined`,
          createdAt: new Date().toISOString(),
          system: true,
        });
      } catch {
        /* an arrival notice must never stop someone joining */
      }
    }

    return { joined: true };
  }

  @SubscribeMessage('leave')
  handleLeave(
    @MessageBody() data: { context: ChatContext; contextId: string },
    @ConnectedSocket() client: AuthedSocket,
  ) {
    client.leave(`${data.context}:${data.contextId}`);
    return { left: true };
  }

  @SubscribeMessage('chat:send')
  async handleChat(
    @MessageBody() data: { context: ChatContext; contextId: string; content: string },
    @ConnectedSocket() client: AuthedSocket,
  ) {
    const userId = client.data.userId;
    if (!userId) return { error: 'unauthenticated' };
    if (!this.checkRateLimit(userId)) return { error: 'rate_limited' };
    if (!data.content || data.content.length > 500) return { error: 'invalid_message' };
    if (await this.moderation.isBanned(data.context, data.contextId, userId)) return { error: 'banned' };
    if (await this.moderation.isMuted(data.context, data.contextId, userId)) return { error: 'muted' };

    const [message, sender] = await Promise.all([
      this.prisma.chatMessage.create({
        data: { context: data.context, contextId: data.contextId, senderId: userId, content: data.content },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
    ]);

    // Same shape as GET /live/:id/chat and GET /rooms/:id/chat history rows.
    this.server.to(`${data.context}:${data.contextId}`).emit('chat:message', {
      id: message.id,
      senderId: message.senderId,
      senderName: sender?.displayName ?? null,
      content: message.content,
      createdAt: message.createdAt,
    });

    return { sent: true };
  }

  // "X is typing…" for direct messages. Ephemeral by design — nothing is
  // stored, and it goes only to the named user's personal room. The sender
  // id comes from the authenticated socket, never from the payload, so it
  // can't be spoofed. Clients send typing:true while composing and
  // typing:false on send/clear; the receiving side also expires it on its
  // own, so a lost "false" can't leave the indicator stuck.
  @SubscribeMessage('dm:typing')
  async handleDmTyping(
    @MessageBody() data: { toUserId?: string; typing?: boolean },
    @ConnectedSocket() client: AuthedSocket,
  ) {
    const userId = client.data.userId;
    if (!userId) return { error: 'unauthenticated' };
    if (!data || typeof data.toUserId !== 'string' || data.toUserId === userId) return { error: 'invalid' };

    const now = Date.now();
    const recent = (this.typingTimestamps.get(userId) ?? []).filter((t) => now - t < this.TYPING_WINDOW_MS);
    if (recent.length >= this.TYPING_MAX) {
      this.typingTimestamps.set(userId, recent);
      return { error: 'rate_limited' };
    }
    recent.push(now);
    this.typingTimestamps.set(userId, recent);

    // Dropped silently — and answered the same as a delivered one — so a
    // blocked sender can't use the indicator to probe whether they're blocked.
    if (await isBlockedEitherWay(this.prisma, userId, data.toUserId)) return { ok: true };

    this.server.to(`user:${data.toUserId}`).emit('dm:typing', { fromUserId: userId, typing: data.typing === true });
    return { ok: true };
  }

  // Called by GiftService's controller layer to broadcast a gift event —
  // keeps GiftService itself transport-agnostic.
  broadcastGift(context: ChatContext, contextId: string, payload: unknown) {
    this.server.to(`${context}:${contextId}`).emit('gift:sent', payload);
  }

  // Sent to everyone in the live session's socket room (clients enter it
  // with the existing 'join' event: { context: 'LIVE', contextId }).
  broadcastLiveLike(sessionId: string, payload: unknown) {
    this.server.to(`LIVE:${sessionId}`).emit('live:like', payload);
  }

  // The host's shared video changed (loaded, played, paused, moved, stopped).
  broadcastLiveMedia(sessionId: string, payload: unknown) {
    this.server.to(`LIVE:${sessionId}`).emit('live:media', payload);
  }

  broadcastLiveViewerCount(sessionId: string, payload: unknown) {
    this.server.to(`LIVE:${sessionId}`).emit('live:viewer_count', payload);
  }

  // Live moderation is broadcast to the current audience and directly to the target.
  // KICK/BAN also remove the target's sockets from the live channel immediately.
  broadcastLiveModeration(
    sessionId: string,
    payload: { sessionId: string; action: string; targetUserId: string; actorId: string },
  ) {
    this.server.to(`LIVE:${sessionId}`).to(`user:${payload.targetUserId}`).emit('live:moderation', payload);
    if (payload.action === 'KICK' || payload.action === 'BAN') {
      this.server.in(`user:${payload.targetUserId}`).socketsLeave(`LIVE:${sessionId}`);
    }
  }

  // Room moderation event. Goes to the whole room (so seat/mute state
  // updates for everyone) AND directly to the target's personal room (so it
  // still reaches them if their socket hasn't joined the room channel).
  // Socket.IO delivers once per socket even when it matches both.
  // On BAN the target's sockets are then removed from the room channel so
  // they stop receiving its chat immediately, without waiting for the
  // client to cooperate.
  broadcastRoomModeration(
    roomId: string,
    payload: { roomId: string; action: string; targetUserId: string; actorId: string },
  ) {
    this.server.to(`ROOM:${roomId}`).to(`user:${payload.targetUserId}`).emit('room:moderation', payload);
    if (payload.action === 'BAN') {
      this.server.in(`user:${payload.targetUserId}`).socketsLeave(`ROOM:${roomId}`);
    }
  }

  // PK lifecycle push (pk:countdown_start / pk:active / pk:settled). Sent to
  // everyone who could care, in one emit (Socket.IO delivers once per
  // socket even if it matches several of these rooms):
  //   - the battle's own channel   (pk:{id})    — anyone already tracking it
  //   - both participants' personal rooms       — so a challenger who
  //     hasn't joined pk:{id} yet still learns their challenge was accepted
  //   - each participant's live session room    — so viewers of either
  //     stream see the countdown/result without polling
  broadcastPkEvent(
    battleId: string,
    userIds: string[],
    liveSessionIds: string[],
    event: 'pk:countdown_start' | 'pk:active' | 'pk:settled',
    payload: unknown,
  ) {
    let op = this.server.to(`pk:${battleId}`);
    for (const userId of userIds) op = op.to(`user:${userId}`);
    for (const sessionId of liveSessionIds) op = op.to(`LIVE:${sessionId}`);
    op.emit(event, payload);
  }

  // Host changed the room theme mid-session — everyone in the room re-skins
  // immediately instead of waiting for their next room-details refetch.
  broadcastRoomTheme(roomId: string, payload: { roomId: string; themeColor: string }) {
    this.server.to(`ROOM:${roomId}`).emit('room:theme', payload);
  }

  broadcastPkScore(pkBattleId: string, payload: unknown) {
    this.server.to(`pk:${pkBattleId}`).emit('pk:score', payload);
  }

  // Whether the user has any live socket right now. Used to decide between
  // an in-app update (they're in the app) and a phone push (they're not) —
  // so someone actively using the app isn't also buzzed on the lock screen.
  async isUserOnline(userId: string): Promise<boolean> {
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    return sockets.length > 0;
  }

  // Every user with a live socket right now (one pass over the connected sockets).
  // Used to list people who are actually online — e.g. PK opponents. Single backend
  // instance only, like the other presence checks.
  async onlineUserIds(): Promise<Set<string>> {
    const sockets = await this.server.fetchSockets();
    const ids = new Set<string>();
    for (const s of sockets) {
      const id = (s.data as { userId?: string } | undefined)?.userId;
      if (id) ids.add(id);
    }
    return ids;
  }

  // Whether `userId` currently has a live socket inside `room` (e.g. the host
  // inside their own 'LIVE:<sessionId>' room). Used to notice a broadcast whose
  // host has gone (app killed, phone died) so it doesn't stay "live" forever.
  async isUserInRoom(userId: string, room: string): Promise<boolean> {
    const sockets = await this.server.in(room).fetchSockets();
    return sockets.some((s) => (s.data as { userId?: string } | undefined)?.userId === userId);
  }

  // The actual point of the personal-room change above — emits directly
  // to one specific user's connected socket(s), regardless of what
  // room/live context they're currently in or whether they're in any at
  // all. Used by CallsService for real, instant call signaling
  // (incoming/accepted/declined/ended) rather than something polled.
  emitToUser(userId: string, event: string, payload: unknown) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const timestamps = (this.messageTimestamps.get(userId) ?? []).filter(
      (t) => now - t < this.RATE_LIMIT_WINDOW_MS,
    );
    if (timestamps.length >= this.RATE_LIMIT_MAX) {
      this.messageTimestamps.set(userId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.messageTimestamps.set(userId, timestamps);
    return true;
  }
}
