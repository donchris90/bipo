import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export type MediaAction = 'load' | 'play' | 'pause' | 'seek' | 'sync' | 'stop';
export const MEDIA_ACTIONS: MediaAction[] = ['load', 'play', 'pause', 'seek', 'sync', 'stop'];
const MAX_POSITION_MS = 24 * 60 * 60 * 1000;

interface State {
  sessionId: string;
  videoId: string;
  title: string;
  url: string;
  status: 'PLAYING' | 'PAUSED';
  positionMs: number; // where the video was at `updatedAt`
  updatedAt: number; // server clock, ms
}

// What a phone receives. `serverNow` lets it work out how far the video has moved
// since `updatedAt` on the SERVER's clock, so phones with a wrong clock still line up.
export interface MediaPayload extends State {
  active: true;
  serverNow: number;
}
export interface MediaStopped {
  sessionId: string;
  active: false;
  serverNow: number;
}

// The video a host is sharing in their live. The host's own phone is the "player";
// the server only remembers what is playing and where, and tells everyone, and every
// viewer's phone plays the same video and keeps in step. Held in memory (single
// backend instance, like the rest of the live state): it ends with the live.
@Injectable()
export class LiveMediaService {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // Where the video is right now.
  private positionNow(s: State, now: number): number {
    return s.status === 'PLAYING' ? s.positionMs + Math.max(0, now - s.updatedAt) : s.positionMs;
  }

  private payload(s: State, now: number): MediaPayload {
    return { ...s, active: true, serverNow: now };
  }

  get(sessionId: string, now = Date.now()): MediaPayload | MediaStopped {
    const s = this.states.get(sessionId);
    return s ? this.payload(s, now) : { sessionId, active: false, serverNow: now };
  }

  async act(
    sessionId: string,
    hostId: string,
    input: { action?: unknown; videoId?: unknown; positionMs?: unknown },
    now = Date.now(),
  ): Promise<MediaPayload | MediaStopped> {
    const action = input.action as MediaAction;
    if (!MEDIA_ACTIONS.includes(action)) throw new BadRequestException(`action must be one of: ${MEDIA_ACTIONS.join(', ')}`);

    const session = await this.prisma.liveSession.findUnique({ where: { id: sessionId }, select: { hostId: true, status: true } });
    if (!session) throw new NotFoundException('Live session not found');
    if (session.hostId !== hostId) throw new ForbiddenException('Only the host can control the video');
    if (session.status !== 'LIVE') throw new BadRequestException('This live has ended');

    if (action === 'stop') {
      this.states.delete(sessionId);
      const stopped: MediaStopped = { sessionId, active: false, serverNow: now };
      this.realtime.broadcastLiveMedia(sessionId, stopped);
      return stopped;
    }

    let position: number | undefined;
    if (input.positionMs !== undefined && input.positionMs !== null) {
      const p = Number(input.positionMs);
      if (!Number.isFinite(p) || p < 0 || p > MAX_POSITION_MS) throw new BadRequestException('positionMs is not valid');
      position = Math.floor(p);
    }

    if (action === 'load') {
      if (typeof input.videoId !== 'string' || !input.videoId) throw new BadRequestException('videoId is required');
      const video = await this.prisma.video.findUnique({ where: { id: input.videoId }, select: { id: true, creatorId: true, title: true, videoUrl: true, status: true } });
      // Only your own published videos: the address has to work for everyone watching.
      if (!video || video.creatorId !== hostId || video.status !== 'PUBLISHED') throw new BadRequestException('Choose one of your published videos');
      const state: State = { sessionId, videoId: video.id, title: video.title, url: video.videoUrl, status: 'PLAYING', positionMs: 0, updatedAt: now };
      this.states.set(sessionId, state);
      return this.publish(state, now);
    }

    const current = this.states.get(sessionId);
    if (!current) throw new BadRequestException('No video is being shared. Choose one first.');

    const at = position ?? this.positionNow(current, now);
    const next: State = { ...current, positionMs: at, updatedAt: now };
    if (action === 'play') next.status = 'PLAYING';
    else if (action === 'pause') next.status = 'PAUSED';
    else if (action === 'sync' && current.status !== 'PLAYING') return this.payload(current, now); // nothing to correct while paused
    // 'seek' and 'sync' keep the current status and just move the position
    this.states.set(sessionId, next);
    return this.publish(next, now);
  }

  private publish(state: State, now: number): MediaPayload {
    const payload = this.payload(state, now);
    this.realtime.broadcastLiveMedia(state.sessionId, payload);
    return payload;
  }

  // The live ended: the shared video ends with it.
  clear(sessionId: string, now = Date.now()) {
    if (!this.states.delete(sessionId)) return;
    this.realtime.broadcastLiveMedia(sessionId, { sessionId, active: false, serverNow: now } as MediaStopped);
  }
}
