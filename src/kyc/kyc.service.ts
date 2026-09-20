import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycStatus, RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { clampLimit, parseBefore, parseEnumFilter } from '../admin/admin-query';
import { cleanFullName, cleanIdNumber, cleanIdType, decodeKycImage, hashIdNumber, namesMatch, parseDateOfBirth } from './kyc-rules';

interface SubmitInput {
  fullName: unknown;
  dateOfBirth: unknown;
  idType: unknown;
  idNumber: unknown;
  idImage: unknown;
  selfieImage: unknown;
}

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private get hashSecret(): string {
    const secret = this.config.get<string>('KYC_HASH_SECRET') ?? this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) throw new Error('KYC_HASH_SECRET (or JWT_ACCESS_SECRET) must be set');
    return secret;
  }

  private view(s: { id: string; status: KycStatus; submittedAt: Date; reviewedAt: Date | null; rejectionReason: string | null; fullName: string; idType: string; idLast4: string }) {
    return {
      id: s.id,
      status: s.status,
      submittedAt: s.submittedAt,
      reviewedAt: s.reviewedAt,
      // Only a rejection explains itself.
      rejectionReason: s.status === 'REJECTED' ? s.rejectionReason : null,
      fullName: s.fullName,
      idType: s.idType,
      idLast4: s.idLast4,
    };
  }

  // What the person sees: are they verified, and where does their latest submission stand.
  async statusFor(userId: string) {
    const [user, latest] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { kycVerified: true } }),
      this.prisma.kycSubmission.findFirst({ where: { userId }, orderBy: { submittedAt: 'desc' } }),
    ]);
    return { verified: !!user?.kycVerified, submission: latest ? this.view(latest) : null };
  }

  async submit(userId: string, input: SubmitInput) {
    const fullName = cleanFullName(input.fullName);
    const dateOfBirth = parseDateOfBirth(input.dateOfBirth);
    const idType = cleanIdType(input.idType);
    const idNumber = cleanIdNumber(idType, input.idNumber);
    const idImage = decodeKycImage(input.idImage, 'The photo of your ID');
    const selfie = decodeKycImage(input.selfieImage, 'Your selfie');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycVerified: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.kycVerified) throw new ConflictException('Your identity is already verified');

    const pending = await this.prisma.kycSubmission.findFirst({ where: { userId, status: 'PENDING' } });
    if (pending) throw new ConflictException('Your documents are already being reviewed');

    // One ID, one account. Deliberately vague about whose it is.
    const idNumberHash = hashIdNumber(this.hashSecret, idType, idNumber);
    const clash = await this.prisma.kycSubmission.findFirst({
      where: { idNumberHash, userId: { not: userId }, status: { in: ['PENDING', 'APPROVED'] } },
      select: { id: true },
    });
    if (clash) throw new ConflictException('This ID cannot be used for this account. If you think this is a mistake, contact support.');

    const created = await this.prisma.$transaction(async (tx) =>
      tx.kycSubmission.create({
        data: {
          userId,
          fullName,
          dateOfBirth,
          idType,
          idLast4: idNumber.slice(-4),
          idNumberHash,
          documents: {
            create: [
              { kind: 'ID_FRONT', contentType: idImage.contentType, sizeBytes: idImage.bytes.length, data: idImage.bytes },
              { kind: 'SELFIE', contentType: selfie.contentType, sizeBytes: selfie.bytes.length, data: selfie.bytes },
            ],
          },
        },
      }),
    );
    await this.audit.record({ actorId: userId, action: 'kyc.submit', targetType: 'kyc_submission', targetId: created.id, metadata: { idType, idLast4: created.idLast4 } as any });
    return this.view(created);
  }

  // ── reviewer side ──────────────────────────────────────────────

  async list(q: { status?: unknown; limit?: unknown; before?: unknown }) {
    const status = parseEnumFilter(q.status, Object.values(KycStatus), KycStatus.PENDING);
    const before = parseBefore(q.before);
    const rows = await this.prisma.kycSubmission.findMany({
      where: { ...(status ? { status } : {}), ...(before ? { submittedAt: { lt: before } } : {}) },
      orderBy: { submittedAt: 'desc' },
      take: clampLimit(q.limit),
    });
    const ids = [...new Set(rows.map((r) => r.userId))];
    const [users, payoutAccounts] = ids.length
      ? await Promise.all([
          this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, email: true } }),
          this.prisma.payoutAccount.findMany({ where: { userId: { in: ids } }, select: { userId: true, accountName: true } }),
        ])
      : [[], []];
    const userById = new Map(users.map((u) => [u.id, u]));
    const payoutById = new Map(payoutAccounts.map((p) => [p.userId, p.accountName]));

    return rows.map((r) => {
      const u = userById.get(r.userId);
      const payoutName = payoutById.get(r.userId) ?? null;
      return {
        ...this.view(r),
        dateOfBirth: r.dateOfBirth.toISOString().slice(0, 10),
        user: u ? { displayName: u.displayName, email: u.email } : null,
        payoutAccountName: payoutName,
        // Hints for the reviewer only; they decide.
        hints: { accountNameMatches: namesMatch(r.fullName, u?.displayName), payoutNameMatches: namesMatch(r.fullName, payoutName) },
        reviewedBy: r.reviewedBy,
      };
    });
  }

  // The photos: only ever sent to an authorised reviewer, never cached, and every
  // look is recorded in the audit log.
  async document(submissionId: string, kind: string, actorId: string, actorRoles: RoleName[]) {
    if (kind !== 'ID_FRONT' && kind !== 'SELFIE') throw new BadRequestException('kind must be ID_FRONT or SELFIE');
    const doc = await this.prisma.kycDocument.findUnique({ where: { submissionId_kind: { submissionId, kind } } });
    if (!doc) {
      const sub = await this.prisma.kycSubmission.findUnique({ where: { id: submissionId }, select: { status: true, reviewedAt: true } });
      if (sub && sub.status !== 'PENDING') throw new NotFoundException('This photo was deleted, as identity photos are removed 7 days after review');
      throw new NotFoundException('Document not found');
    }
    await this.audit.record({ actorId, actorRole: actorRoles[0], action: 'kyc.view_document', targetType: 'kyc_submission', targetId: submissionId, metadata: { kind } as any });
    return { contentType: doc.contentType, data: Buffer.from(doc.data) };
  }

  async approve(submissionId: string, reviewerId: string, reviewerRoles: RoleName[]) {
    const sub = await this.prisma.$transaction(async (tx) => {
      const s = await tx.kycSubmission.findUnique({ where: { id: submissionId } });
      if (!s) throw new NotFoundException('Submission not found');
      if (s.status !== 'PENDING') throw new ConflictException('This submission has already been decided');
      // Nobody verifies themselves.
      if (s.userId === reviewerId) throw new ForbiddenException('You cannot review your own identity check');
      const clash = await tx.kycSubmission.findFirst({ where: { idNumberHash: s.idNumberHash, userId: { not: s.userId }, status: 'APPROVED' }, select: { id: true } });
      if (clash) throw new ConflictException('This ID is already verified on another account');

      const updated = await tx.kycSubmission.update({ where: { id: s.id }, data: { status: 'APPROVED', reviewedAt: new Date(), reviewedBy: reviewerId, rejectionReason: null } });
      await tx.user.update({ where: { id: s.userId }, data: { kycVerified: true } });
      return updated;
    });
    await this.audit.record({ actorId: reviewerId, actorRole: reviewerRoles[0], action: 'kyc.approve', targetType: 'kyc_submission', targetId: submissionId, metadata: { userId: sub.userId } as any });
    await this.notifications.notify(sub.userId, 'SECURITY', { event: 'kyc_approved' }).catch((e) => this.logger.warn(`kyc notify failed: ${e?.message ?? e}`));
    return this.view(sub);
  }

  async reject(submissionId: string, reviewerId: string, reviewerRoles: RoleName[], reason: unknown) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < 3 || text.length > 300) throw new BadRequestException('Give a reason of 3 to 300 characters — it is shown to the person');
    const s = await this.prisma.kycSubmission.findUnique({ where: { id: submissionId } });
    if (!s) throw new NotFoundException('Submission not found');
    if (s.status !== 'PENDING') throw new ConflictException('This submission has already been decided');
    if (s.userId === reviewerId) throw new ForbiddenException('You cannot review your own identity check');

    const sub = await this.prisma.kycSubmission.update({ where: { id: s.id }, data: { status: 'REJECTED', reviewedAt: new Date(), reviewedBy: reviewerId, rejectionReason: text } });
    await this.audit.record({ actorId: reviewerId, actorRole: reviewerRoles[0], action: 'kyc.reject', targetType: 'kyc_submission', targetId: submissionId, metadata: { userId: s.userId, reason: text } as any });
    await this.notifications.notify(s.userId, 'SECURITY', { event: 'kyc_rejected', reason: text }).catch((e) => this.logger.warn(`kyc notify failed: ${e?.message ?? e}`));
    return this.view(sub);
  }
}
