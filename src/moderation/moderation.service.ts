import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatContext } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// RoomsService.muteGuest/banGuest already write ModerationAction rows —
// this is the read side those actions were missing. "Current state" is
// derived from the most recent action of the relevant pair (MUTE/UNMUTE,
// BAN/UNBAN) rather than a separate mutable status column, so the audit
// trail and the enforcement state can never drift apart.
@Injectable()
export class ModerationService {
  constructor(private readonly prisma: PrismaService) {}

  async isMuted(context: ChatContext, contextId: string, userId: string): Promise<boolean> {
    const latest = await this.prisma.moderationAction.findFirst({
      where: { context, contextId, targetUserId: userId, actionType: { in: ['MUTE', 'UNMUTE'] } },
      orderBy: { createdAt: 'desc' },
    });
    return latest?.actionType === 'MUTE';
  }

  // Everyone whose latest MUTE/UNMUTE action in this context is MUTE.
  // Replays the action log in order so the last action per user wins —
  // same "derive state from the audit trail" approach as isMuted().
  async mutedUserIds(context: ChatContext, contextId: string): Promise<string[]> {
    const actions = await this.prisma.moderationAction.findMany({
      where: { context, contextId, actionType: { in: ['MUTE', 'UNMUTE'] }, targetUserId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { targetUserId: true, actionType: true },
    });
    const muted = new Map<string, boolean>();
    for (const a of actions) muted.set(a.targetUserId as string, a.actionType === 'MUTE');
    return [...muted.entries()].filter(([, isMuted]) => isMuted).map(([id]) => id);
  }

  async isBanned(context: ChatContext, contextId: string, userId: string): Promise<boolean> {
    const latest = await this.prisma.moderationAction.findFirst({
      where: { context, contextId, targetUserId: userId, actionType: { in: ['BAN', 'UNBAN'] } },
      orderBy: { createdAt: 'desc' },
    });
    return latest?.actionType === 'BAN';
  }

  async createReport(reporterId: string, input: { targetUserId: string; category: string; description?: string; context?: string; contextId?: string }) {
    const targetUserId = String(input.targetUserId ?? '').trim();
    const category = String(input.category ?? '').trim().toUpperCase();
    const allowed = new Set(['HARASSMENT', 'SCAM', 'INAPPROPRIATE_CONTENT', 'IMPERSONATION', 'SPAM', 'OTHER']);
    if (!targetUserId || reporterId === targetUserId) throw new BadRequestException('Invalid report target');
    if (!allowed.has(category)) throw new BadRequestException('Invalid report category');
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');
    const recent = await this.prisma.userReport.findFirst({ where: { reporterId, targetUserId, status: 'OPEN', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } } });
    if (recent) return { id: recent.id, status: recent.status, duplicate: true };
    const report = await this.prisma.userReport.create({ data: {
      reporterId, targetUserId, category,
      description: input.description?.trim().slice(0, 1000) || null,
      context: input.context?.trim().slice(0, 80) || null,
      contextId: input.contextId?.trim().slice(0, 120) || null,
    }});
    return { id: report.id, status: report.status, duplicate: false };
  }

  async listReports(query: Record<string, unknown>) {
    const status = typeof query.status === 'string' && ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'].includes(query.status) ? query.status : undefined;
    const limitRaw = Number(query.limit ?? 50);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));
    const reports = await this.prisma.userReport.findMany({ where: { ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: limit });
    const ids = [...new Set(reports.flatMap(r => [r.reporterId, r.targetUserId, r.reviewerId]).filter(Boolean) as string[])];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, email: true, status: true } });
    const map = new Map(users.map(u => [u.id, u]));
    return reports.map(r => ({ ...r, reporter: map.get(r.reporterId) ?? null, target: map.get(r.targetUserId) ?? null, reviewer: r.reviewerId ? map.get(r.reviewerId) ?? null : null }));
  }

  async resolveReport(id: string, reviewerId: string, input: { status: string; resolution?: string }) {
    const status = String(input.status ?? '').toUpperCase();
    if (!['REVIEWING', 'RESOLVED', 'DISMISSED'].includes(status)) throw new BadRequestException('Invalid report status');
    const report = await this.prisma.userReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('Report not found');
    return this.prisma.userReport.update({ where: { id }, data: { status, reviewerId, resolution: input.resolution?.trim().slice(0, 1000) || null } });
  }

}

