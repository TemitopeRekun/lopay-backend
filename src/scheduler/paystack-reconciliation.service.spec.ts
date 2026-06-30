import { PaystackReconciliationService } from './paystack-reconciliation.service';

describe('PaystackReconciliationService', () => {
  const prisma = {
    withLeaderLock: jest.fn(),
    payment: { findMany: jest.fn() },
  };
  const paystack = { verifyTransaction: jest.fn() };
  const enrollment = {
    reconcilePaystackPayment: jest.fn(),
    failPaystackPayment: jest.fn(),
  };
  const service = new PaystackReconciliationService(
    prisma as never,
    paystack as never,
    enrollment as never,
  );

  const NOW = new Date('2026-06-30T12:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  const stale = (ref: string, ageMs: number) => ({
    id: ref,
    paystackReference: ref,
    paymentDate: new Date(NOW.getTime() - ageMs),
  });
  const run = () =>
    (service as unknown as { runSweep(): Promise<void> }).runSweep();

  it('reconciles a payment that verifies as success', async () => {
    prisma.payment.findMany.mockResolvedValue([stale('ref1', 10 * 60 * 1000)]);
    paystack.verifyTransaction.mockResolvedValue({
      status: 'success',
      fees: 1500,
    });
    await run();
    expect(enrollment.reconcilePaystackPayment).toHaveBeenCalledWith(
      'ref1',
      1500,
      null,
    );
    expect(enrollment.failPaystackPayment).not.toHaveBeenCalled();
  });

  it('fails a payment that verifies as failed', async () => {
    prisma.payment.findMany.mockResolvedValue([stale('ref2', 10 * 60 * 1000)]);
    paystack.verifyTransaction.mockResolvedValue({ status: 'failed' });
    await run();
    expect(enrollment.failPaystackPayment).toHaveBeenCalledWith('ref2');
    expect(enrollment.reconcilePaystackPayment).not.toHaveBeenCalled();
  });

  it('abandons an unresolved payment older than 24h', async () => {
    prisma.payment.findMany.mockResolvedValue([
      stale('ref3', 25 * 60 * 60 * 1000), // > ABANDON_AGE
    ]);
    paystack.verifyTransaction.mockResolvedValue({ status: 'abandoned' });
    await run();
    expect(enrollment.failPaystackPayment).toHaveBeenCalledWith('ref3');
  });

  it('leaves a recently-abandoned payment alone (within the 24h window)', async () => {
    prisma.payment.findMany.mockResolvedValue([
      stale('ref4', 30 * 60 * 1000), // 30 min — past MIN_AGE, well under ABANDON_AGE
    ]);
    paystack.verifyTransaction.mockResolvedValue({ status: 'abandoned' });
    await run();
    expect(enrollment.failPaystackPayment).not.toHaveBeenCalled();
    expect(enrollment.reconcilePaystackPayment).not.toHaveBeenCalled();
  });

  it('continues the sweep when one verification throws', async () => {
    prisma.payment.findMany.mockResolvedValue([
      stale('boom', 10 * 60 * 1000),
      stale('ok', 10 * 60 * 1000),
    ]);
    paystack.verifyTransaction
      .mockRejectedValueOnce(new Error('paystack down'))
      .mockResolvedValueOnce({ status: 'success', fees: 0 });
    await run();
    expect(enrollment.reconcilePaystackPayment).toHaveBeenCalledWith(
      'ok',
      0,
      null,
    );
  });

  it('skips when the leader lock is held elsewhere', async () => {
    prisma.withLeaderLock.mockResolvedValue(false);
    await service.sweep();
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});
