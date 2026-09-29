import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { MatchSession } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RTC_PROVIDER } from '../live/live.service';
import type { RtcProvider } from '../live/providers/rtc-provider.interface';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { publicName } from '../common/public-name';

// A waiting ticket that hasn't been heard from (polled) in this long is treated as gone — the
// person closed the app or lost signal — and is never paired with anyone.
export const TICKET_TTL_MS = 15_000;
// Tickets nobody has touched for this long are deleted outright (housekeeping, done lazily on join).
const TICKET_PURGE_MS = 5 * 60_000;
// A session with no explicit end (app killed) stops counting as "active" after this long.
const SESSION_MAX_AGE_MS = 30 * 60_000;

export type MatchView =
  | { status: 'IDLE' }
  | { status: 'SEARCHING' }
  | {
      status: 'MATCHED';
      session: { id: string; otherUserId: string; otherDisplayName: string; otherAvatarUrl: string | null; otherCountryCode: string | null; startedAt: Date };
    };

// Random 1-on-1 video match between two strangers.
//
// Pairing is claim-based rather than lock-based, so it stays correct with several backend
// instances and needs no Redis:
//   * Only the NEWER of two waiting people ever initiates a pairing (candidates must have an older
//     ticket), so two people can never cross-claim each other at the same moment.
//   * The initiator claims its own ticket (WAITING -> MATCHED) and then the candidate's with a
//     conditional update; whichever update matches zero rows lost the race and backs off.
//   * A person who is waiting keeps polling status(), which retries pairing — so nobody is
//     stranded by one lost race.
@Injectable()
export class MatchingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ---- Queue ---------------------------------------------------------------------------------

  async join(userId: string, sameCountryOnly = false): Promise<MatchView> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true, countryCode: true } });
    if (!user || user.status !== 'ACTIVE') throw new ForbiddenException('Your account cannot use Match right now');

    // Joining the queue means "I'm done with whoever I'm with" — end the current session first
    // rather than leaving the user stuck inside a session they already walked away from.
    const current = await this.activeSessionFor(userId);
    if (current) await this.endSession(current, userId);

    await this.prisma.matchTicket.deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - TICKET_PURGE_MS) } } });
    const now = new Date();
    await this.prisma.matchTicket.upsert({
      where: { userId },
      update: { status: 'WAITING', sameCountryOnly, countryCode: user.countryCode, sessionId: null, createdAt: now, lastSeenAt: now },
      create: { userId, sameCountryOnly, countryCode: user.countryCode },
    });
    return this.tryPair(userId);
  }

  // Polled by the app while searching (and while matched, as the reconciliation check).
  async status(userId: string): Promise<MatchView> {
    const active = await this.activeSessionFor(userId);
    if (active) return this.matchedView(active, userId);
    const ticket = await this.prisma.matchTicket.findUnique({ where: { userId } });
    if (!ticket) return { status: 'IDLE' };
    if (ticket.status === 'WAITING') {
      await this.prisma.matchTicket.update({ where: { userId }, data: { lastSeenAt: new Date() } });
    }
    return this.tryPair(userId);
  }

  async cancel(userId: string) {
    const removed = await this.prisma.matchTicket.deleteMany({ where: { userId, status: 'WAITING' } });
    return { cancelled: removed.count > 0 };
  }

  private async tryPair(userId: string): Promise<MatchView> {
    const mine = await this.prisma.matchTicket.findUnique({ where: { userId } });
    if (!mine) return { status: 'IDLE' };
    if (mine.status === 'MATCHED') {
      const session = mine.sessionId ? await this.prisma.matchSession.findUnique({ where: { id: mine.sessionId } }) : null;
      return session && session.status === 'ACTIVE' ? this.matchedView(session, userId) : { status: 'SEARCHING' };
    }

    const blocks = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blockedIds = blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId));

    const candidates = (
      await this.prisma.matchTicket.findMany({
        where: {
          status: 'WAITING',
          userId: { not: userId, notIn: blockedIds },
          lastSeenAt: { gte: new Date(Date.now() - TICKET_TTL_MS) },
          OR: [{ createdAt: { lt: mine.createdAt } }, { createdAt: mine.createdAt, userId: { lt: userId } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 25,
      })
    ).filter((c) => {
      if (!mine.sameCountryOnly && !c.sameCountryOnly) return true;
      return c.countryCode === mine.countryCode;
    });
    if (candidates.length === 0) return { status: 'SEARCHING' };

    // Claim my own ticket first. Zero rows means someone newer already claimed me — fine, the
    // next poll will show the session they created.
    const claimedMine = await this.prisma.matchTicket.updateMany({ where: { id: mine.id, status: 'WAITING' }, data: { status: 'MATCHED' } });
    if (claimedMine.count === 0) return { status: 'SEARCHING' };

    for (const candidate of candidates) {
      const claimed = await this.prisma.matchTicket.updateMany({ where: { id: candidate.id, status: 'WAITING' }, data: { status: 'MATCHED' } });
      if (claimed.count === 0) continue;
      try {
        const { channelName } = await this.rtc.createChannel(`match-${randomUUID()}`);
        const session = await this.prisma.$transaction(async (tx) => {
          const created = await tx.matchSession.create({ data: { userAId: candidate.userId, userBId: userId, providerChannel: channelName } });
          await tx.matchTicket.update({ where: { id: candidate.id }, data: { sessionId: created.id } });
          await tx.matchTicket.update({ where: { id: mine.id }, data: { sessionId: created.id } });
          return created;
        });
        this.realtime.emitToUser(candidate.userId, 'match:found', { sessionId: session.id });
        return this.matchedView(session, userId);
      } catch {
        // Couldn't create the channel/session: put the candidate back so they aren't lost, and
        // release my own claim below.
        await this.prisma.matchTicket.updateMany({ where: { id: candidate.id, sessionId: null }, data: { status: 'WAITING' } });
        break;
      }
    }

    await this.prisma.matchTicket.updateMany({ where: { id: mine.id, sessionId: null }, data: { status: 'WAITING' } });
    return { status: 'SEARCHING' };
  }

  // ---- Sessions ------------------------------------------------------------------------------

  private async activeSessionFor(userId: string) {
    return this.prisma.matchSession.findFirst({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: new Date(Date.now() - SESSION_MAX_AGE_MS) },
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async matchedView(session: MatchSession, viewerId: string): Promise<MatchView> {
    const otherId = session.userAId === viewerId ? session.userBId : session.userAId;
    const other = await this.prisma.user.findUnique({ where: { id: otherId }, select: { displayName: true, avatarUrl: true, countryCode: true } });
    return {
      status: 'MATCHED',
      session: {
        id: session.id,
        otherUserId: otherId,
        otherDisplayName: publicName(other?.displayName, otherId),
        otherAvatarUrl: other?.avatarUrl ?? null,
        otherCountryCode: other?.countryCode ?? null,
        startedAt: session.createdAt,
      },
    };
  }

  private async requireMember(sessionId: string, userId: string) {
    const session = await this.prisma.matchSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Match not found');
    if (session.userAId !== userId && session.userBId !== userId) throw new ForbiddenException();
    return session;
  }

  // What the in-call screen polls: is it still on, did I like them, and did it become mutual.
  // The other person's like is deliberately NOT revealed unless it is mutual.
  async sessionState(sessionId: string, userId: string) {
    const session = await this.requireMember(sessionId, userId);
    const iAmA = session.userAId === userId;
    const iLiked = iAmA ? session.aLiked : session.bLiked;
    const theyLiked = iAmA ? session.bLiked : session.aLiked;
    return { id: session.id, status: session.status, iLiked, mutual: iLiked && theyLiked };
  }

  async joinToken(sessionId: string, userId: string) {
    const session = await this.requireMember(sessionId, userId);
    if (session.status !== 'ACTIVE') throw new BadRequestException('This match has ended');
    const token = await this.rtc.generateToken(session.providerChannel, userId, 'host');
    return { channelId: session.providerChannel, token };
  }

  // Both people liking each other makes them follow each other — the "keep talking" step that
  // turns a random stranger into a connection. The follow is skipped if either has since blocked
  // the other.
  async like(sessionId: string, userId: string) {
    const session = await this.requireMember(sessionId, userId);
    if (session.status !== 'ACTIVE') throw new BadRequestException('This match has ended');
    const iAmA = session.userAId === userId;
    const updated = await this.prisma.matchSession.update({ where: { id: sessionId }, data: iAmA ? { aLiked: true } : { bLiked: true } });
    const mutual = updated.aLiked && updated.bLiked;
    if (mutual) {
      const blocked = await this.prisma.block.findFirst({
        where: { OR: [{ blockerId: updated.userAId, blockedId: updated.userBId }, { blockerId: updated.userBId, blockedId: updated.userAId }] },
      });
      if (!blocked) {
        await this.prisma.follow.createMany({
          data: [
            { followerId: updated.userAId, followingId: updated.userBId },
            { followerId: updated.userBId, followingId: updated.userAId },
          ],
          skipDuplicates: true,
        });
      }
      const otherId = iAmA ? updated.userBId : updated.userAId;
      this.realtime.emitToUser(otherId, 'match:mutual', { sessionId });
    }
    return { mutual };
  }

  async end(sessionId: string, userId: string) {
    const session = await this.requireMember(sessionId, userId);
    await this.endSession(session, userId);
    return { ended: true };
  }

  private async endSession(session: MatchSession, endedById: string) {
    // Conditional on still ACTIVE so two people hanging up together can't both "win" the
    // transition and destroy the channel / notify twice.
    const flipped = await this.prisma.matchSession.updateMany({
      where: { id: session.id, status: 'ACTIVE' },
      data: { status: 'ENDED', endedAt: new Date(), endedById },
    });
    if (flipped.count === 0) return;
    await this.prisma.matchTicket.deleteMany({ where: { userId: { in: [session.userAId, session.userBId] } } });
    try {
      await this.rtc.destroyChannel(session.providerChannel);
    } catch {
      /* the channel expires by itself; ending the session must not fail on it */
    }
    const otherId = session.userAId === endedById ? session.userBId : session.userAId;
    this.realtime.emitToUser(otherId, 'match:ended', { sessionId: session.id });
  }
}
