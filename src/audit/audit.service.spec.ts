import { AuditService } from './audit.service';
import { AuditAction } from '../generated/prisma/client';

describe('AuditService', () => {
  const prisma = {
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const service = new AuditService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  describe('record', () => {
    it('writes the audit row on the base prisma client when no tx is passed', async () => {
      await service.record({
        action: AuditAction.PAYMENT_CONFIRMED,
        entityType: 'Payment',
        entityId: 'p1',
        actor: { userId: 'u1', role: 'SUPER_ADMIN' },
        schoolId: 's1',
        reason: 'ok',
        before: { a: 1 },
        after: { a: 2 },
        metadata: { ip: '127.0.0.1' },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: AuditAction.PAYMENT_CONFIRMED,
          entityType: 'Payment',
          entityId: 'p1',
          actorUserId: 'u1',
          actorRole: 'SUPER_ADMIN',
          schoolId: 's1',
          reason: 'ok',
          before: { a: 1 },
          after: { a: 2 },
          metadata: { ip: '127.0.0.1' },
        },
      });
    });

    it('defaults actor/school/reason to null and json fields to undefined for a system action', async () => {
      await service.record({
        action: AuditAction.ENROLLMENT_DEFAULTED,
        entityType: 'Enrollment',
        entityId: 'e1',
      });
      const data = prisma.auditLog.create.mock.calls[0][0].data;
      expect(data.actorUserId).toBeNull();
      expect(data.actorRole).toBeNull();
      expect(data.schoolId).toBeNull();
      expect(data.reason).toBeNull();
      expect(data.before).toBeUndefined();
      expect(data.after).toBeUndefined();
      expect(data.metadata).toBeUndefined();
    });

    it('coerces a null actor to null actor fields', async () => {
      await service.record({
        action: AuditAction.PAYMENT_REJECTED,
        entityType: 'Payment',
        entityId: 'p3',
        actor: null,
      });
      const data = prisma.auditLog.create.mock.calls[0][0].data;
      expect(data.actorUserId).toBeNull();
      expect(data.actorRole).toBeNull();
    });

    it('writes onto the provided transaction client instead of the base prisma', async () => {
      const tx = {
        auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      };
      await service.record(
        {
          action: AuditAction.PAYMENT_REVERSED,
          entityType: 'Payment',
          entityId: 'p2',
        },
        tx as never,
      );
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('applies all filters and passes explicit take/skip through', async () => {
      prisma.$transaction.mockResolvedValueOnce([[{ id: 'a1' }], 1]);
      const result = await service.list({
        entityType: 'Payment',
        entityId: 'p1',
        schoolId: 's1',
        actorUserId: 'u1',
        take: 5,
        skip: 10,
      });
      const findArgs = prisma.auditLog.findMany.mock.calls[0][0];
      expect(findArgs.where).toEqual({
        entityType: 'Payment',
        entityId: 'p1',
        schoolId: 's1',
        actorUserId: 'u1',
      });
      expect(findArgs.take).toBe(5);
      expect(findArgs.skip).toBe(10);
      expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
      expect(result).toEqual({
        items: [{ id: 'a1' }],
        total: 1,
        take: 5,
        skip: 10,
      });
    });

    it('defaults take to 50 and skip to 0 with no paging args', async () => {
      prisma.$transaction.mockResolvedValueOnce([[], 0]);
      const result = await service.list({});
      expect(result.take).toBe(50);
      expect(result.skip).toBe(0);
    });

    it('caps take at 200 and floors skip at 0', async () => {
      prisma.$transaction.mockResolvedValueOnce([[], 0]);
      const result = await service.list({ take: 9999, skip: -5 });
      expect(result.take).toBe(200);
      expect(result.skip).toBe(0);
    });

    it('raises take to the minimum of 1 for a non-positive value', async () => {
      prisma.$transaction.mockResolvedValueOnce([[], 0]);
      const result = await service.list({ take: 0 });
      expect(result.take).toBe(1);
    });
  });
});
