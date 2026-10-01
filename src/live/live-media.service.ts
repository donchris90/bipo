import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export type MediaAction = 'load' | 'play' | 'pause' | 'seek' | 'sync' | 'stop';
export const MEDIA_ACTIONS: MediaAction[] = ['load', 'play', 'pause', 'seek', 'sync', 'stop'];
const MAX_POSITION_MS = 24 * 60 * 60 * 1000;

// Pulls the 11-character video id out of the usual YouTube link shapes (watch, youtu.be, shorts,
// embed, live) or a bare id. Anything else is rejected, so only real YouTube videos ever load.
export function parseYouTubeId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/);
      id = m ? m[1] : null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// Asks YouTube whether a video can be played outside youtube.com before the room commits to it.
// YouTube's oEmbed answers 200 (with the title) for embeddable videos, 401/403 when the owner
// disabled embedding, and 404 when the video is private or removed. Network trouble or any other
// answer lets the video through: the player reports a clear error if it really can't play.
export type YouTubeCheck = { ok: true; title?: string } | { ok: false; reason: string };
export async function checkYouTube(id: string, fetchFn: typeof fetch = fetch, timeoutMs = 4000): Promise<YouTubeCheck> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: ctrl.signal });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "The owner of this video doesn't allow it to be played outside YouTube. Please pick another video." };
    }
    if (res.status === 404) return { ok: false, reason: 'This video is private or has been removed. Please pick another video.' };
    if (res.ok) {
      const body: any = await res.json().catch(() => null);
      return { ok: true, title: typeof body?.title === 'string' ? body.title.slice(0, 120) : undefined };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

interface State {
  sessionId: string;
  // 'upload' = one of the host's published videos (url); 'youtube' = a YouTube video (youtubeId).
  kind: 'upload' | 'youtube';
  youtubeId?: string;
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
    input: { action?: unknown; videoId?: unknown; youtubeUrl?: unknown; positionMs?: unknown },
    now = Date.now(),
  ): Promise<MediaPayload | MediaStopped> {
    const action = input.action as MediaAction;
    if (!MEDIA_ACTIONS.includes(action)) throw new BadRequestException(`action must be one of: ${MEDIA_ACTIONS.join(', ')}`);

    // The id is either a solo live session or a party room: the same video feature serves both.
    const live = await this.prisma.liveSession.findUnique({ where: { id: sessionId }, select: { hostId: true, status: true } });
    const partyRoom = live ? null : await (this.prisma as any).partyRoom?.findUnique({ where: { id: sessionId }, select: { hostId: true, status: true } });
    const session = live ?? partyRoom;
    if (!session) throw new NotFoundException('Live session not found');
    if (session.hostId !== hostId) throw new ForbiddenException('Only the host can control the video');
    const isRoom = !live;
    if (isRoom ? session.status !== 'OPEN' : session.status !== 'LIVE') throw new BadRequestException(isRoom ? 'This room has closed' : 'This live has ended');

    if (action === 'stop') {
      this.states.delete(sessionId);
      const stopped: MediaStopped = { sessionId, active: false, serverNow: now };
      this.broadcast(sessionId, stopped, isRoom);
      return stopped;
    }

    let position: number | undefined;
    if (input.positionMs !== undefined && input.positionMs !== null) {
      const p = Number(input.positionMs);
      if (!Number.isFinite(p) || p < 0 || p > MAX_POSITION_MS) throw new BadRequestException('positionMs is not valid');
      position = Math.floor(p);
    }

    if (action === 'load' && input.youtubeUrl !== undefined) {
      const youtubeId = parseYouTubeId(input.youtubeUrl);
      if (!youtubeId) throw new BadRequestException('That is not a YouTube link');
      const check = await checkYouTube(youtubeId);
      if (!check.ok) throw new BadRequestException(check.reason);
      const state: State = { sessionId, kind: 'youtube', youtubeId, videoId: `yt:${youtubeId}`, title: check.title ?? 'YouTube', url: '', status: 'PLAYING', positionMs: 0, updatedAt: now };
      this.states.set(sessionId, state);
      return this.publish(state, now, isRoom);
    }

    if (action === 'load') {
      if (typeof input.videoId !== 'string' || !input.videoId) throw new BadRequestException('videoId is required');
      const video = await this.prisma.video.findUnique({ where: { id: input.videoId }, select: { id: true, creatorId: true, title: true, videoUrl: true, status: true } });
      // Only your own published videos: the address has to work for everyone watching.
      if (!video || video.creatorId !== hostId || video.status !== 'PUBLISHED') throw new BadRequestException('Choose one of your published videos');
      const state: State = { sessionId, kind: 'upload', videoId: video.id, title: video.title, url: video.videoUrl, status: 'PLAYING', positionMs: 0, updatedAt: now };
      this.states.set(sessionId, state);
      return this.publish(state, now, isRoom);
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
    return this.publish(next, now, isRoom);
  }

  private broadcast(id: string, payload: unknown, isRoom: boolean) {
    this.realtime.broadcastLiveMedia(id, payload);
    // Party-room members listen on the room channel, not the live-session one.
    if (isRoom) (this.realtime as any).broadcastRoomMedia?.(id, payload);
  }

  private publish(state: State, now: number, isRoom = false): MediaPayload {
    const payload = this.payload(state, now);
    this.broadcast(state.sessionId, payload, isRoom);
    return payload;
  }

  // The live ended: the shared video ends with it.
  clear(sessionId: string, now = Date.now()) {
    if (!this.states.delete(sessionId)) return;
    this.realtime.broadcastLiveMedia(sessionId, { sessionId, active: false, serverNow: now } as MediaStopped);
  }
}
