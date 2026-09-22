import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoleName } from '@prisma/client';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: RoleName | null;
  action: string; // dot-namespaced, e.g. "user.suspend", "flag.toggle"
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  // Fire-and-forget from the caller's perspective, but never silently swallow
  // failures in production — an audit write failing on a sensitive action
  // should itself be alertable, not just logged to console.
  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata as any,
        ipAddress: entry.ipAddress,
      },
    });
  }
}
