import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RTC_PROVIDER } from '../live/live.service';
import type { RtcProvider } from '../live/providers/rtc-provider.interface';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotBlocked } from '../common/blocks';

@Injectable()
export class CallsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  private async notifyMissed(call: { id: string; callerId: string; calleeId: string }) {
    const caller = await this.prisma.user.findUnique({ where: { id: call.callerId }, select: { displayName: true } });
    await this.notifications.notifyOnce(call.calleeId, 'MISSED_CALL', `missed:${call.id}`, {
      callId: call.id,
      callerId: call.callerId,
      callerDisplayName: caller?.displayName ?? null,
    });
  }

  // A call ringing longer than this without being answered auto-resolves
  // to MISSED the next time anything checks its status — see getStatus().
  // Not a cron job; checked lazily, same tradeoff as everywhere else in
  // this backend that treats "still real, just not instant" as an
  // acceptable honest choice over new scheduled-job infrastructure.
  private static readonly RING_TIMEOUT_MS = 45_000;

  async initiate(callerId: string, calleeId: string) {
    if (callerId === calleeId) throw new BadRequestException("You can't call yourself");
    const callee = await this.prisma.user.findUnique({ where: { id: calleeId }, select: { id: true } });
    if (!callee) throw new NotFoundException('User not found');
    await assertNotBlocked(this.prisma, callerId, calleeId, "You can't call this user");

    const existingRinging = await this.prisma.call.findFirst({
      where: { callerId, calleeId, status: 'RINGING' },
    });
    if (existingRinging) return existingRinging;

    const { channelName } = await this.rtc.createChannel(`call-${Date.now()}`);
    const call = await this.prisma.call.create({
      data: { callerId, calleeId, providerChannel: channelName },
    });

    // The actual point of this whole feature — an instant signal to the
    // callee's socket, not something they'd only discover by polling.
    // Enriched with the caller's real display name (one extra lookup at
    // call-initiation time, not per-poll) so the incoming-call screen
    // shows a name instead of a raw id.
    const caller = await this.prisma.user.findUnique({ where: { id: callerId }, select: { displayName: true } });
    this.realtime.emitToUser(calleeId, 'call:incoming', { callId: call.id, callerId, callerDisplayName: caller?.displayName ?? null });

    return call;
  }

  // Real-time-first (the emit above), but this REST status check is
  // still the source of truth a client reconciles against — e.g. after
  // reconnecting, or if the socket event was missed for any reason.
  async getStatus(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();

    if (call.status === 'RINGING' && Date.now() - call.createdAt.getTime() > CallsService.RING_TIMEOUT_MS) {
      // Conditional on still RINGING, so two concurrent status checks can't
      // both "win" the transition and notify the callee twice.
      const flipped = await this.prisma.call.updateMany({
        where: { id: callId, status: 'RINGING' },
        data: { status: 'MISSED', endedAt: new Date() },
      });
      const missed = await this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
      if (flipped.count === 1) {
        this.realtime.emitToUser(call.callerId, 'call:missed', { callId });
        await this.notifyMissed(call);
      }
      return missed;
    }
    return call;
  }

  async accept(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.calleeId !== userId) throw new ForbiddenException('Only the callee can accept');
    if (call.status !== 'RINGING') throw new BadRequestException('This call is no longer ringing');

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'ACCEPTED', startedAt: new Date() },
    });
    this.realtime.emitToUser(call.callerId, 'call:accepted', { callId });
    return updated;
  }

  async decline(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.calleeId !== userId) throw new ForbiddenException('Only the callee can decline');
    if (call.status !== 'RINGING') throw new BadRequestException('This call is no longer ringing');

    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'DECLINED', endedAt: new Date() },
    });
    this.realtime.emitToUser(call.callerId, 'call:declined', { callId });
    return updated;
  }

  async end(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();
    if (call.status === 'ENDED' || call.status === 'DECLINED' || call.status === 'MISSED') return call;

    await this.rtc.destroyChannel(call.providerChannel);
    const updated = await this.prisma.call.update({
      where: { id: callId },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
    this.realtime.emitToUser(otherUserId, 'call:ended', { callId });

    // The caller giving up while it was still ringing is a missed call from
    // the callee's side, whether or not the 45s timeout ever fired.
    if (call.status === 'RINGING' && userId === call.callerId) await this.notifyMissed(call);
    return updated;
  }

  // A real, fresh publish token for whichever side of the call this user
  // is on — same joinToken pattern LiveService/RoomsService already use.
  async joinToken(callId: string, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw new ForbiddenException();
    const token = await this.rtc.generateToken(call.providerChannel, userId, 'host');
    return { call, token };
  }
}
