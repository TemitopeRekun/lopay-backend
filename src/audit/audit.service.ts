import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, Prisma } from '../generated/prisma/client';

export interface AuditActor {
  userId: string;
  role?: string | null;
}

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** Who performed the action; null/undefined for system (e.g. scheduler) actions. */
  actor?: AuditActor | null;
  schoolId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

/**
 * Accepts either the base PrismaService or a transaction client, so callers can
 * write the audit row inside the same transaction as the change it describes.
 */
type AuditDbClient = PrismaService | Prisma.TransactionClient;

const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined ? undefined : (value as Prisma.InputJsonValue);

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an immutable audit record. Pass a transaction client (`tx`) to make
   * the audit write atomic with the state change; omit it to log standalone.
   */
  async record(entry: AuditEntry, client?: AuditDbClient): Promise<void> {
    const db = client ?? this.prisma;
    await db.auditLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        actorUserId: entry.actor?.userId ?? null,
        actorRole: entry.actor?.role ?? null,
        schoolId: entry.schoolId ?? null,
        reason: entry.reason ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        metadata: toJson(entry.metadata),
      },
    });
  }

  /** Read the audit trail, newest first, with optional filters + paging. */
  async list(filters: {
    entityType?: string;
    entityId?: string;
    schoolId?: string;
    actorUserId?: string;
    take?: number;
    skip?: number;
  }) {
    const take = Math.min(Math.max(filters.take ?? 50, 1), 200);
    const skip = Math.max(filters.skip ?? 0, 0);
    const where: Prisma.AuditLogWhereInput = {
      entityType: filters.entityType,
      entityId: filters.entityId,
      schoolId: filters.schoolId,
      actorUserId: filters.actorUserId,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total, take, skip };
  }
}
