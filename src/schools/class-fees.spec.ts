import { BadRequestException } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';

/**
 * The fee-schedule write path used by first-run school setup.
 *
 * A school owns its own fees, so these all run against a session-derived
 * schoolId; the controller spec covers the fact that no payload field can
 * redirect the write elsewhere.
 */
describe('SchoolPaymentsService — class fees', () => {
  const upsertResult = (n: number) => ({ op: 'classFee.upsert', n });

  const prisma = {
    classFee: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
    withTenant: jest.fn(),
  };
  const cache = {
    del: jest.fn(),
    getOrSet: jest.fn(),
  };

  const service = new SchoolPaymentsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
    {} as never, // paystack (unused by the class-fee paths)
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.classFee.upsert.mockImplementation(() => upsertResult(1));
    prisma.classFee.updateMany.mockImplementation(() => ({
      op: 'classFee.updateMany',
    }));
    prisma.$transaction.mockResolvedValue([]);
    // getClassFees reads back through the cache loader.
    cache.getOrSet.mockImplementation(
      (_k: string, _ttl: number, loader: () => unknown) => loader(),
    );
    prisma.withTenant.mockReturnValue({
      classFee: { findMany: jest.fn().mockResolvedValue([]) },
    });
  });

  describe('setClassFees', () => {
    it('writes the whole schedule in ONE transaction', async () => {
      await service.setClassFees('s1', [
        { className: 'JSS1', feeAmount: 120000 },
        { className: 'JSS2', feeAmount: 150000 },
        { className: 'JSS3', feeAmount: 180000 },
      ]);

      // Previously one HTTP request per class with a 2.5s client-side sleep;
      // a partially-saved schedule was possible if the tab was closed midway.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.classFee.upsert).toHaveBeenCalledTimes(3);
      // 3 upserts + the one deactivation sweep.
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(4);
    });

    describe('editing an existing schedule', () => {
      it('raises a price', async () => {
        await service.setClassFees('s1', [
          { className: 'JSS1', feeAmount: 200000 },
        ]);
        expect(prisma.classFee.upsert.mock.calls[0][0].update).toEqual({
          feeAmount: 20000000,
          isActive: true,
        });
      });

      it('lowers a price', async () => {
        await service.setClassFees('s1', [
          { className: 'JSS1', feeAmount: 50000 },
        ]);
        expect(prisma.classFee.upsert.mock.calls[0][0].update.feeAmount).toBe(
          5000000,
        );
      });

      it('deactivates a class the school dropped from the schedule', async () => {
        await service.setClassFees('s1', [
          { className: 'JSS1', feeAmount: 100 },
          { className: 'JSS2', feeAmount: 200 },
        ]);

        // Upserting alone left a removed class isActive, so parents kept seeing
        // it and could still enrol at the old price.
        expect(prisma.classFee.updateMany).toHaveBeenCalledWith({
          where: {
            schoolId: 's1',
            isActive: true,
            className: { notIn: ['JSS1', 'JSS2'] },
          },
          data: { isActive: false },
        });
      });

      it('retires classes in the SAME transaction as the writes', async () => {
        await service.setClassFees('s1', [
          { className: 'JSS1', feeAmount: 100 },
        ]);
        // A separate call could leave the schedule inconsistent if it failed.
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
      });

      it('keeps every submitted class active (retires none of them)', async () => {
        await service.setClassFees('s1', [
          { className: 'JSS1', feeAmount: 100 },
          { className: 'SS1', feeAmount: 300 },
        ]);
        const notIn =
          prisma.classFee.updateMany.mock.calls[0][0].where.className.notIn;
        expect(notIn).toEqual(['JSS1', 'SS1']);
      });

      it('revives a previously retired class when it is re-added', async () => {
        await service.setClassFees('s1', [
          { className: 'JSS3', feeAmount: 175000 },
        ]);
        // isActive flips back to true on the upsert's update branch.
        expect(prisma.classFee.upsert.mock.calls[0][0].update.isActive).toBe(
          true,
        );
      });

      it('does not retire anything when the transaction fails', async () => {
        prisma.$transaction.mockRejectedValueOnce(new Error('deadlock'));
        await expect(
          service.setClassFees('s1', [{ className: 'JSS1', feeAmount: 1 }]),
        ).rejects.toThrow('deadlock');
        // The sweep was queued but never committed, so the cache must stand.
        expect(cache.del).not.toHaveBeenCalled();
      });
    });

    it('converts naira to integer kobo', async () => {
      await service.setClassFees('s1', [
        { className: 'JSS1', feeAmount: 1200.5 },
      ]);

      const arg = prisma.classFee.upsert.mock.calls[0][0];
      expect(arg.create.feeAmount).toBe(120050);
      expect(arg.update.feeAmount).toBe(120050);
    });

    it('scopes every write to the given school', async () => {
      await service.setClassFees('s1', [
        { className: 'JSS1', feeAmount: 100 },
        { className: 'JSS2', feeAmount: 200 },
      ]);

      for (const call of prisma.classFee.upsert.mock.calls) {
        expect(call[0].where.schoolId_className.schoolId).toBe('s1');
        expect(call[0].create.schoolId).toBe('s1');
      }
    });

    it('upserts on (schoolId, className) so a re-publish updates in place', async () => {
      await service.setClassFees('s1', [{ className: 'JSS1', feeAmount: 999 }]);

      const arg = prisma.classFee.upsert.mock.calls[0][0];
      expect(arg.where.schoolId_className).toEqual({
        schoolId: 's1',
        className: 'JSS1',
      });
    });

    it('reactivates a class that had been deactivated', async () => {
      await service.setClassFees('s1', [{ className: 'JSS1', feeAmount: 10 }]);
      expect(prisma.classFee.upsert.mock.calls[0][0].update.isActive).toBe(
        true,
      );
    });

    it('trims class names so " JSS1" and "JSS1" are one class', async () => {
      await service.setClassFees('s1', [
        { className: '  JSS1  ', feeAmount: 100 },
      ]);
      expect(
        prisma.classFee.upsert.mock.calls[0][0].where.schoolId_className
          .className,
      ).toBe('JSS1');
    });

    it('rejects a duplicated class name instead of silently picking one', async () => {
      await expect(
        service.setClassFees('s1', [
          { className: 'JSS1', feeAmount: 100 },
          { className: 'jss1', feeAmount: 200 },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Nothing is written when the payload is ambiguous.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('invalidates the cached fee list after committing', async () => {
      await service.setClassFees('s1', [{ className: 'JSS1', feeAmount: 100 }]);
      expect(cache.del).toHaveBeenCalledWith('cache:classfees:s1');
    });

    it('does not invalidate the cache when the transaction fails', async () => {
      prisma.$transaction.mockRejectedValueOnce(new Error('deadlock'));

      await expect(
        service.setClassFees('s1', [{ className: 'JSS1', feeAmount: 100 }]),
      ).rejects.toThrow('deadlock');

      // A read racing an aborted write must not repopulate from rolled-back rows.
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('returns the resulting schedule so the client need not refetch', async () => {
      prisma.withTenant.mockReturnValue({
        classFee: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'f1', className: 'JSS1', feeAmount: 120000 },
            ]),
        },
      });

      const res = await service.setClassFees('s1', [
        { className: 'JSS1', feeAmount: 1200 },
      ]);

      // Read back in naira, matching every other fee response.
      expect(res).toEqual([
        expect.objectContaining({ className: 'JSS1', feeAmount: 1200 }),
      ]);
    });
  });
});
