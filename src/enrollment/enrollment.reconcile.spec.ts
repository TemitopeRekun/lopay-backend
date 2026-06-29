import { EnrollmentService } from './enrollment.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  AuditAction,
} from '../generated/prisma/client';

/**
 * CHARACTERIZATION suite for the Paystack money-state transitions owned (today)
 * by EnrollmentService: reconcilePaystackPayment (charge.success / verify) and
 * failPaystackPayment (charge.failed).
 *
 * Milestone 3 moves these into the LedgerService. These lock the CURRENT
 * replay-safe behavior — the webhook AND the verify-on-return endpoint both call
 * reconcile, so the SUCCESS flip must be exactly-once — plus the estimate-vs-actual
 * Paystack fee reconciliation. Written test-first (green pre-refactor).
 */
describe('EnrollmentService — paystack reconcile (characterization)', () => {
  let tx: {
    payment: { updateMany: jest.Mock };
    childEnrollment: { update: jest.Mock };
  };
  let prisma: {
    payment: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let notifications: { create: jest.Mock };
  let events: {
    emitEnrollmentsChanged: jest.Mock;
    emitPaymentsChanged: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let service: EnrollmentService;

  function makePayment(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pay-1',
      schoolId: 'school-1',
      enrollmentId: 'enr-1',
      paystackReference: 'ref-1',
      status: PaymentTransactionStatus.PENDING,
      isConfirmed: false,
      amountPaid: 100_000,
      amountCharged: 102_000,
      platformAmount: 2_000,
      schoolAmount: 100_000,
      paystackFee: 1_500, // estimate
      enrollment: {
        id: 'enr-1',
        className: 'JSS1',
        remainingBalance: 50_000, // > 0 -> ACTIVE on success
        school: { name: 'Acme School', ownerId: 'owner-1' },
        child: { fullName: 'Ada Lovelace', parent: { userId: 'parent-1' } },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    tx = {
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      childEnrollment: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      payment: { findUnique: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    events = {
      emitEnrollmentsChanged: jest.fn(),
      emitPaymentsChanged: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    service = new EnrollmentService(
      prisma as never,
      {} as never, // paymentService (unused here)
      notifications as never,
      events as never,
      audit as never,
      {} as never, // paystack (unused here)
    );
  });

  describe('reconcilePaystackPayment', () => {
    it('flips PENDING -> SUCCESS, activates the enrollment, and records the fee delta', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(makePayment());

      const result = await service.reconcilePaystackPayment(
        'ref-1',
        1_800,
        null,
      );

      // guarded exactly-once flip
      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: PaymentTransactionStatus.PENDING },
        data: expect.objectContaining({
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          actualPaystackFee: 1_800,
        }),
      });
      // balance still owed -> ACTIVE (not COMPLETED)
      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: { paymentStatus: PaymentStatus.ACTIVE },
      });
      // estimate 1500 vs actual 1800 -> delta 300 surfaced for reconciliation
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.FIRST_PAYMENT_PAID,
          metadata: expect.objectContaining({
            estimatedPaystackFee: 1_500,
            actualPaystackFee: 1_800,
            paystackFeeDelta: 300,
          }),
        }),
        tx,
      );
      expect(result).toEqual({ reconciled: true, completed: false });
      expect(events.emitPaymentsChanged).toHaveBeenCalled();
    });

    it('marks the enrollment COMPLETED when nothing remains owed', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(
        makePayment({
          enrollment: {
            id: 'enr-1',
            className: 'JSS1',
            remainingBalance: 0, // fully covered -> COMPLETED
            school: { name: 'Acme', ownerId: 'owner-1' },
            child: { fullName: 'Ada', parent: { userId: 'parent-1' } },
          },
        }),
      );

      const result = await service.reconcilePaystackPayment(
        'ref-1',
        null,
        null,
      );

      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: { paymentStatus: PaymentStatus.COMPLETED },
      });
      expect(result).toEqual({ reconciled: true, completed: true });
    });

    it('is a clean no-op for an unknown reference', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);

      const result = await service.reconcilePaystackPayment('nope', null, null);

      expect(result).toEqual({
        reconciled: false,
        reason: 'unknown_reference',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('short-circuits an already-SUCCESS payment (replay before the tx)', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(
        makePayment({ status: PaymentTransactionStatus.SUCCESS }),
      );

      const result = await service.reconcilePaystackPayment(
        'ref-1',
        null,
        null,
      );

      expect(result).toEqual({ reconciled: true, alreadyProcessed: true });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('treats a concurrent flip (count===0) as already-processed, no audit/notify', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(makePayment());
      tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.reconcilePaystackPayment(
        'ref-1',
        null,
        null,
      );

      expect(result).toEqual({ reconciled: true, alreadyProcessed: true });
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
      expect(events.emitPaymentsChanged).not.toHaveBeenCalled();
    });
  });

  describe('failPaystackPayment', () => {
    it('flips a PENDING payment to FAILED and fails the enrollment', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(makePayment());

      const result = await service.failPaystackPayment('ref-1');

      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: PaymentTransactionStatus.PENDING },
        data: { status: PaymentTransactionStatus.FAILED },
      });
      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
      expect(result).toEqual({ updated: true });
    });

    it('no-ops a non-PENDING payment (replayed charge.failed cannot un-succeed)', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(
        makePayment({ status: PaymentTransactionStatus.SUCCESS }),
      );

      const result = await service.failPaystackPayment('ref-1');

      expect(result).toEqual({ updated: false });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
