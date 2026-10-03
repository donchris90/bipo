import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ChatContext } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ModerationDecision = {
  allowed: boolean;
  category?: string;
  severity?: number;
  action?: string;
  message?: string;
  matchedRuleId?: string;
};

const BUILTIN_RULES = [
  { phrase: 'fuck', category: 'PROFANITY', severity: 1, action: 'BLOCK', enforceInPrivate: false },
  { phrase: 'shit', category: 'PROFANITY', severity: 1, action: 'BLOCK', enforceInPrivate: false },
  { phrase: 'bitch', category: 'PROFANITY', severity: 1, action: 'BLOCK', enforceInPrivate: false },
  { phrase: 'asshole', category: 'PROFANITY', severity: 1, action: 'BLOCK', enforceInPrivate: false },
  { phrase: 'motherfucker', category: 'PROFANITY', severity: 1, action: 'BLOCK', enforceInPrivate: false },
  { phrase: 'cunt', category: 'PROFANITY', severity: 2, action: 'MUTE', enforceInPrivate: false },
  { phrase: 'kill yourself', category: 'HARASSMENT', severity: 3, action: 'MUTE' },
  { phrase: 'i will kill you', category: 'THREAT', severity: 4, action: 'KICK' },
  { phrase: 'send me money', category: 'SCAM', severity: 2, action: 'MUTE' },
  { phrase: 'send coins and i will', category: 'SCAM', severity: 2, action: 'MUTE' },
  { phrase: 't.me/', category: 'EXTERNAL_CONTACT', severity: 2, action: 'BLOCK', enforceInPrivate: false },
  { phrase: 'wa.me/', category: 'EXTERNAL_CONTACT', severity: 2, action: 'BLOCK', enforceInPrivate: false },
];

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{8,}\d)/;

function normalize(value: string): { spaced: string; compact: string } {
  const homoglyphs: Record<string, string> = {
    'а': 'a', 'е': 'e', 'і': 'i', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y',
    'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ι': 'i', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't', 'Χ': 'x',
  };
  let text = value.normalize('NFKD').toLowerCase();
  text = [...text].map((c) => homoglyphs[c] ?? c).join('');
  text = text.replace(/[\u0300-\u036f]/g, '');
  // Turn punctuation/emoji into spaces, while keeping letters and numbers.
  text = text.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/(.)\1{2,}/gu, '$1$1').trim();
  return { spaced: text, compact: text.replace(/\s+/g, '') };
}

function phraseMatches(content: string, phrase: string): boolean {
  const text = normalize(content);
  const rule = normalize(phrase);
  if (!rule.spaced) return false;
  // Normal boundary matching catches ordinary words and phrases.
  const escaped = rule.spaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, 'i').test(text.spaced)) return true;
  // Compact matching catches "f u c k" / punctuation obfuscation, but only for
  // rules of at least four letters to avoid false positives on short words.
  return rule.compact.length >= 4 && text.compact.includes(rule.compact);
}

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => RealtimeGateway)) private readonly realtime: RealtimeGateway,
  ) {}

  async isMuted(context: ChatContext, contextId: string, userId: string): Promise<boolean> {
    const latest = await this.prisma.moderationAction.findFirst({
      where: { context, contextId, targetUserId: userId, actionType: { in: ['MUTE', 'UNMUTE'] } },
      orderBy: { createdAt: 'desc' },
    });
    return latest?.actionType === 'MUTE';
  }

  async mutedUserIds(context: ChatContext, contextId: string): Promise<string[]> {
    const actions = await this.prisma.moderationAction.findMany({
      where: { context, contextId, actionType: { in: ['MUTE', 'UNMUTE'] }, targetUserId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { targetUserId: true, actionType: true },
    });
    const muted = new Map<string, boolean>();
    for (const a of actions) muted.set(a.targetUserId as string, a.actionType === 'MUTE');
    return [...muted.entries()].filter(([, mutedNow]) => mutedNow).map(([id]) => id);
  }

  async isBanned(context: ChatContext, contextId: string, userId: string): Promise<boolean> {
    const latest = await this.prisma.moderationAction.findFirst({
      where: { context, contextId, targetUserId: userId, actionType: { in: ['BAN', 'UNBAN'] } },
      orderBy: { createdAt: 'desc' },
    });
    return latest?.actionType === 'BAN';
  }

  /**
   * Server-side chat moderation. The message is inspected before it is stored
   * or broadcast. Raw offending text is intentionally not persisted in the
   * moderation tables; the report/audit trail records only category/severity.
   */
  async inspectChat(context: ChatContext, contextId: string, userId: string, content: string): Promise<ModerationDecision> {
    const value = String(content ?? '').trim();
    if (!value) return { allowed: false, category: 'INVALID', severity: 1, action: 'BLOCK', message: 'Message is empty.' };

    const isPrivate = await this.isPrivateContext(context, contextId);
    const dbRules = await this.prisma.moderationRule.findMany({
      where: { active: true },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, phrase: true, category: true, severity: true, action: true, enforceInPrivate: true },
    }).catch(() => []);

    const rules = [...dbRules, ...BUILTIN_RULES.map((r) => ({ ...r, id: undefined as string | undefined, enforceInPrivate: r.enforceInPrivate ?? true }))]
      .filter((r) => !isPrivate || r.enforceInPrivate !== false);

    // Private sessions are intentionally more relaxed, but they are NOT
    // unmoderated. Severe safety categories remain enforced. Public LIVE/ROOM
    // always block obvious external-contact sharing.
    const automatic = context === 'LIVE' || context === 'ROOM'
      ? (!isPrivate && (URL_RE.test(value) || PHONE_RE.test(value)) ? {
          category: 'EXTERNAL_CONTACT', severity: 2, action: 'BLOCK', message: 'External links and phone numbers are not allowed in public live chat.', enforceInPrivate: false,
        } : null)
      : null;

    const matched = automatic ?? rules.find((r) => phraseMatches(value, r.phrase));
    if (!matched) return { allowed: true };

    const decision: ModerationDecision = {
      allowed: false,
      category: matched.category,
      severity: matched.severity,
      action: matched.action,
      message: matched.message ?? this.warningFor(matched.category),
      matchedRuleId: matched.id,
    };

    await this.recordViolation(context, contextId, userId, decision);
    return decision;
  }

  private async isPrivateContext(context: ChatContext, contextId: string): Promise<boolean> {
    if (context === 'LIVE') {
      const session = await this.prisma.liveSession.findUnique({ where: { id: contextId }, select: { privacy: true } });
      return session?.privacy === 'PRIVATE';
    }
    if (context === 'ROOM') {
      const room = await this.prisma.partyRoom.findUnique({ where: { id: contextId }, select: { privacy: true } });
      return room?.privacy === 'PRIVATE';
    }
    return false;
  }

  private warningFor(category: string): string {
    switch (category) {
      case 'THREAT': return 'Threatening or violent language is not allowed.';
      case 'HARASSMENT': return 'Harassment and abusive language are not allowed.';
      case 'SCAM': return 'Soliciting money or coins from users is not allowed.';
      case 'EXTERNAL_CONTACT': return 'External links and phone numbers are not allowed in live chat.';
      case 'SEXUAL': return 'Sexually explicit or soliciting content is not allowed.';
      default: return 'That message cannot be posted because it violates the live chat rules.';
    }
  }

  private async recordViolation(context: ChatContext, contextId: string, userId: string, decision: ModerationDecision) {
    await this.prisma.moderationViolation.create({
      data: {
        userId,
        context,
        contextId,
        category: decision.category ?? 'OTHER',
        severity: decision.severity ?? 1,
        action: decision.action ?? 'BLOCK',
        matchedRuleId: decision.matchedRuleId ?? null,
      },
    }).catch(() => undefined);

    // A rule configured as MUTE/KICK is an immediate context-level action.
    // Ordinary profanity defaults to BLOCK only; repeated blocks can be promoted
    // to a MUTE rule by an admin without changing the mobile app.
    if (decision.action === 'MUTE' || decision.action === 'KICK') {
      await this.prisma.moderationAction.create({
        data: {
          actorId: 'SYSTEM_MODERATION',
          actionType: decision.action === 'KICK' ? 'KICK' : 'MUTE',
          targetUserId: userId,
          context,
          contextId,
          reason: `Automatic moderation: ${decision.category}`,
        },
      }).catch(() => undefined);
    }
  }

  /**
   * Records a trusted audio/video moderation signal. Detection itself is kept
   * behind a provider boundary (speech-to-text/vision service); the mobile app
   * must never be allowed to self-report a media violation as authoritative.
   * Public live enforces the full policy. Private live/party relaxes ordinary
   * adult-content/contact rules but keeps severe safety categories enforced.
   */
  async ingestMediaSignal(input: {
    context: ChatContext;
    contextId: string;
    subjectUserId: string;
    source: 'AUDIO_TRANSCRIPT' | 'VIDEO_FRAME' | 'VIDEO_STREAM';
    category: string;
    confidence?: number;
    provider?: string;
    providerEventId?: string;
  }) {
    const category = String(input.category || 'OTHER').toUpperCase();
    const confidence = input.confidence == null ? undefined : Math.max(0, Math.min(1, Number(input.confidence)));
    const isPrivate = await this.isPrivateContext(input.context, input.contextId);
    const severe = new Set(['THREAT', 'CHILD_SAFETY', 'EXPLOITATION', 'VIOLENCE', 'HATE', 'SCAM', 'COERCION']);
    const relaxedPrivate = new Set(['PROFANITY', 'ADULT_SUGGESTIVE', 'EXTERNAL_CONTACT']);
    if (isPrivate && relaxedPrivate.has(category)) {
      return { accepted: true, action: 'LOG', category, privateException: true };
    }

    // Avoid acting on low-confidence automated detections. Severe categories
    // are still recorded for human review even when they do not auto-restrict.
    const threshold = severe.has(category) ? 0.80 : 0.90;
    const action = confidence == null || confidence >= threshold
      ? (severe.has(category) ? 'MUTE' : 'FLAG')
      : 'FLAG';
    const event = await this.prisma.moderationMediaEvent.create({
      data: {
        context: input.context,
        contextId: input.contextId,
        subjectUserId: input.subjectUserId,
        source: input.source,
        category,
        severity: severe.has(category) ? 4 : 2,
        confidence: confidence ?? null,
        action,
        provider: input.provider ?? null,
        providerEventId: input.providerEventId ?? null,
      },
    });

    if (action === 'MUTE') {
      await this.prisma.moderationAction.create({
        data: {
          actorId: 'SYSTEM_MODERATION',
          actionType: 'MUTE',
          targetUserId: input.subjectUserId,
          context: input.context,
          contextId: input.contextId,
          reason: `Automatic ${input.source} moderation: ${category}`,
        },
      }).catch(() => undefined);

      // Push immediately so an active Solo/Party client can disable its local
      // microphone/camera without waiting for a REST refresh. The persisted
      // MUTE action still protects the user after reconnect.
      try {
        this.realtime.broadcastMediaModeration(input.context, input.contextId, {
          action: 'MUTE',
          targetUserId: input.subjectUserId,
          source: input.source,
          category,
          eventId: event.id,
          reason: `Automatic ${input.source} moderation: ${category}`,
        });
      } catch {
        // Enforcement state is already persisted; realtime delivery is best-effort.
      }
    }
    return { accepted: true, action, category, eventId: event.id, privateException: false };
  }

  async createReport(reporterId: string, input: { targetUserId: string; category: string; description?: string; context?: string; contextId?: string }) {
    const targetUserId = String(input.targetUserId ?? '').trim();
    const category = String(input.category ?? '').trim().toUpperCase();
    const allowed = new Set(['HARASSMENT', 'SCAM', 'INAPPROPRIATE_CONTENT', 'IMPERSONATION', 'SPAM', 'THREAT', 'SEXUAL', 'HATE', 'OTHER']);
    if (!targetUserId || reporterId === targetUserId) throw new BadRequestException('Invalid report target');
    if (!allowed.has(category)) throw new BadRequestException('Invalid report category');
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');
    const recent = await this.prisma.userReport.findFirst({
      where: {
        reporterId,
        targetUserId,
        status: 'OPEN',
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60_000),
        },
      },
    });
    if (recent) return { id: recent.id, status: recent.status, duplicate: true };
    const report = await this.prisma.userReport.create({
      data: {
        reporterId, targetUserId, category,
        description: input.description?.trim().slice(0, 1000) || null,
        context: input.context?.trim().slice(0, 80) || null,
        contextId: input.contextId?.trim().slice(0, 120) || null,
      },
    });
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
    const updated = await this.prisma.userReport.update({
      where: { id },
      data: { status, reviewerId, resolution: input.resolution?.trim().slice(0, 1000) || null },
    });
    await this.prisma.auditLog.create({
      data: { actorId: reviewerId, action: 'report.resolve', targetType: 'user_report', targetId: id, metadata: { from: report.status, to: status } },
    });
    return updated;
  }

  async listMediaEvents(query: Record<string, unknown>) {
    const limitRaw = Number(query.limit ?? 100);
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));
    const context = typeof query.context === 'string' && ['LIVE', 'ROOM'].includes(query.context) ? query.context as ChatContext : undefined;
    return this.prisma.moderationMediaEvent.findMany({
      where: { ...(context ? { context } : {}), ...(typeof query.category === 'string' ? { category: query.category.toUpperCase() } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async listRules() {
    return this.prisma.moderationRule.findMany({ orderBy: [{ active: 'desc' }, { severity: 'desc' }, { phrase: 'asc' }] });
  }

  async createRule(input: { phrase: string; category: string; severity?: number; action?: string; enforceInPrivate?: boolean }) {
    const phrase = String(input.phrase ?? '').trim();
    const category = String(input.category ?? '').trim().toUpperCase();
    const severity = Math.min(4, Math.max(1, Math.floor(Number(input.severity ?? 1))));
    const action = String(input.action ?? 'BLOCK').toUpperCase();
    if (phrase.length < 2 || phrase.length > 120) throw new BadRequestException('Rule phrase must be 2-120 characters');
    if (!/^[A-Z0-9_]+$/.test(category)) throw new BadRequestException('Invalid rule category');
    if (!['BLOCK', 'MUTE', 'KICK'].includes(action)) throw new BadRequestException('Invalid rule action');
    return this.prisma.moderationRule.create({ data: { phrase, category, severity, action, enforceInPrivate: input.enforceInPrivate !== false } });
  }

  async updateRule(id: string, input: { phrase?: string; category?: string; severity?: number; action?: string; active?: boolean; enforceInPrivate?: boolean }) {
    const existing = await this.prisma.moderationRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Rule not found');
    const data: Record<string, unknown> = {};
    if (input.phrase !== undefined) data.phrase = String(input.phrase).trim().slice(0, 120);
    if (input.category !== undefined) data.category = String(input.category).trim().toUpperCase();
    if (input.severity !== undefined) data.severity = Math.min(4, Math.max(1, Math.floor(Number(input.severity))));
    if (input.action !== undefined) data.action = String(input.action).toUpperCase();
    if (input.active !== undefined) data.active = !!input.active;
    if (input.enforceInPrivate !== undefined) data.enforceInPrivate = !!input.enforceInPrivate;
    return this.prisma.moderationRule.update({ where: { id }, data });
  }

  async deleteRule(id: string) {
    const existing = await this.prisma.moderationRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Rule not found');
    await this.prisma.moderationRule.delete({ where: { id } });
    return { deleted: true };
  }
}
