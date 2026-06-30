import { DefaulterDetectionService } from './defaulter-detection.service';
import { PaymentStatus } from '../generated/prisma/client';

describe('DefaulterDetectionService', () => {
  const prisma = {
    withLeaderLock: jest.fn(),
    childEnrollment: { findMany: jest.fn() },
  };
  const ledger = { markEnrollmentDefaultedBySweep: jest.fn() };
  const service = new DefaulterDetectionService(
    prisma as never,
    ledger as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  const overdueRow = (id: string) => ({
    id,
    schoolId: 'sch',
    remainingBalance: 50_000,
    child: { fullName: 'Ada', parent: { userId: 'u1' } },
    school: { name: 'Acme' },
  });

  it('skips when the leader lock is held by another instance', async () => {
    prisma.withLeaderLock.mockResolvedValue(false); // did not acquire
    await service.detectDefaulters();
    expect(prisma.childEnrollment.findMany).not.toHaveBeenCalled();
  });

  it('runs the sweep when it acquires the lock', async () => {
    prisma.withLeaderLock.mockImplementation(
      async (_n: string, _ttl: number, fn: () => Promise<void>) => {
        await fn();
        return true;
      },
    );
    prisma.childEnrollment.findMany.mockResolvedValue([]);
    await service.detectDefaulters();
    expect(prisma.childEnrollment.findMany).toHaveBeenCalledTimes(1);
  });

  it('queries only ACTIVE, past-term, positive-balance enrollments', async () => {
    prisma.childEnrollment.findMany.mockResolvedValue([]);
    await (
      service as unknown as { runDetection(): Promise<void> }
    ).runDetection();
    const where = prisma.childEnrollment.findMany.mock.calls[0][0].where;
    expect(where.paymentStatus).toBe(PaymentStatus.ACTIVE);
    expect(where.remainingBalance).toEqual({ gt: 0 });
    expect(where.termEndDate.lt).toBeInstanceOf(Date);
  });

  it('delegates each overdue row to the ledger (no balance math here)', async () => {
    prisma.childEnrollment.findMany.mockResolvedValue([
      overdueRow('e1'),
      overdueRow('e2'),
    ]);
    ledger.markEnrollmentDefaultedBySweep
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await (
      service as unknown as { runDetection(): Promise<void> }
    ).runDetection();
    expect(ledger.markEnrollmentDefaultedBySweep).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there are no overdue enrollments', async () => {
    prisma.childEnrollment.findMany.mockResolvedValue([]);
    await (
      service as unknown as { runDetection(): Promise<void> }
    ).runDetection();
    expect(ledger.markEnrollmentDefaultedBySweep).not.toHaveBeenCalled();
  });
});
