import { BadRequestException } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  AuditAction,
} from '../generated/prisma/client';

/**
 * CHARACTERIZATION suite for the money-state transitions owned (today) by
 * SchoolPaymentsService: confirm / reject / reverse installment payments.
 *
 * Milestone 3 extracts these into a LedgerService. These tests lock the CURRENT
 * observable behavior — guarded write → atomic balance inc/dec → clamp → audit
 * → notify → emit — so the extraction is provably behavior-preserving. They are
 * written test-first (green against the pre-refactor code) and will be retargeted
 * at LedgerService once the logic moves, with the SAME assertions.
 *
 * The $transaction mock EXECUTES its callback against a `tx` double, so the inner
 * tx.* writes, the audit payload, and the clamp branches are all exercised.
 */
describe('SchoolPaymentsService — ledger (characterization)', () => {
  // --- tx double: the object passed to the $transaction callback ---
  let tx: {
    payment: {
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    childEnrollment: {
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
  };

  // --- top-level prisma double ---
  let prisma: {
    withTenant: jest.Mock;
    $transaction: jest.Mock;
  };
  let tenant: { payment: { findFirst: jest.Mock } };

  let notifications: { create: jest.Mock };
  let events: {
    emitPaymentsChanged: jest.Mock;
    emitEnrollmentsChanged: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let service: SchoolPaymentsService;

  const SCHOOL_ID = 'school-1';
  const actor = { userId: 'owner-1', role: 'SCHOOL_OWNER' } as never;

  /** A confirmed-able INSTALLMENT payment with the relations the method reads. */
  function makeInstallment(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pay-1',
      schoolId: SCHOOL_ID,
      enrollmentId: 'enr-1',
      amountPaid: 50_000, // 500.00 NGN in kobo
      isConfirmed: false,
      status: PaymentTransactionStatus.PENDING,
      paymentType: PaymentType.INSTALLMENT,
      paymentDate: null,
      enrollment: {
        className: 'JSS1',
        school: { name: 'Acme School', ownerId: 'owner-1' },
        child: { fullName: 'Ada Lovelace', parent: { userId: 'parent-1' } },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    tx = {
      payment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      childEnrollment: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    };
    tenant = { payment: { findFirst: jest.fn() } };
    prisma = {
      withTenant: jest.fn().mockReturnValue(tenant),
      // Execute the callback against the tx double (real control flow).
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    events = {
      emitPaymentsChanged: jest.fn(),
      emitEnrollmentsChanged: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    service = new SchoolPaymentsService(
      prisma as never,
      notifications as never,
      {} as never, // documentsService (unused here)
      events as never,
      audit as never,
      {} as never, // authService (unused here)
    );
  });

  // ---------------------------------------------------------------- confirm
  describe('confirmPayment', () => {
    it('decrements the balance by the paid amount (atomic decrement, not read-modify-write)', async () => {
      const payment = makeInstallment();
      tenant.payment.findFirst.mockResolvedValueOnce(payment);
      tx.childEnrollment.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'enr-1',
        remainingBalance: 120_000,
        totalSchoolFee: 150_000,
        paymentStatus: PaymentStatus.ACTIVE,
      });
      // decrement leaves a positive balance -> NOT completed
      tx.childEnrollment.update.mockResolvedValueOnce({
        id: 'enr-1',
        remainingBalance: 70_000,
      });
      tx.payment.findUniqueOrThrow.mockResolvedValueOnce({
        ...payment,
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
        paymentDate: new Date(),
      });

      const result = await service.confirmPayment('pay-1', SCHOOL_ID, actor);

      // guarded conditional write on the payment
      expect(tx.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'pay-1',
            schoolId: SCHOOL_ID,
            isConfirmed: false,
            paymentType: PaymentType.INSTALLMENT,
          },
          data: expect.objectContaining({
            isConfirmed: true,
            status: PaymentTransactionStatus.SUCCESS,
          }),
        }),
      );
      // ATOMIC decrement by amountPaid
      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: { remainingBalance: { decrement: 50_000 } },
      });
      // not completed -> only the single decrement update (no clamp-to-0 write)
      expect(tx.childEnrollment.update).toHaveBeenCalledTimes(1);
      // kobo -> naira on the returned amount
      expect(result.amount).toBe(500);
      // realtime fan-out after commit
      expect(events.emitPaymentsChanged).toHaveBeenCalledWith({
        parentUserId: 'parent-1',
        schoolId: SCHOOL_ID,
        notifyAdmins: true,
      });
    });

    it('clamps to 0 and marks COMPLETED when the decrement reaches/passes zero', async () => {
      const payment = makeInstallment({ amountPaid: 120_000 });
      tenant.payment.findFirst.mockResolvedValueOnce(payment);
      tx.childEnrollment.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'enr-1',
        remainingBalance: 100_000,
        totalSchoolFee: 150_000,
        paymentStatus: PaymentStatus.ACTIVE,
      });
      // overpayment -> negative running balance
      tx.childEnrollment.update
        .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: -20_000 })
        .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: 0 });
      tx.payment.findUniqueOrThrow.mockResolvedValueOnce(payment);

      await service.confirmPayment('pay-1', SCHOOL_ID, actor);

      // second update clamps to 0 + COMPLETED
      expect(tx.childEnrollment.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'enr-1' },
        data: { remainingBalance: 0, paymentStatus: PaymentStatus.COMPLETED },
      });
      // audit reflects completion
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_CONFIRMED,
          after: expect.objectContaining({
            remainingBalance: 0,
            enrollmentStatus: PaymentStatus.COMPLETED,
          }),
        }),
        tx,
      );
    });

    it('is idempotent under a concurrent confirm: count===0 -> BadRequest, no balance/audit/notify', async () => {
      tenant.payment.findFirst.mockResolvedValueOnce(makeInstallment());
      tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.confirmPayment('pay-1', SCHOOL_ID, actor),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.childEnrollment.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('rejects a cross-tenant / unknown payment before opening a transaction (IDOR guard)', async () => {
      // withTenant scoping returns null for a payment owned by another school
      tenant.payment.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.confirmPayment('foreign-pay', SCHOOL_ID, actor),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.withTenant).toHaveBeenCalledWith(SCHOOL_ID);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------- reject
  describe('rejectPayment', () => {
    it('marks the payment FAILED and fails the enrollment for a FIRST_PAYMENT', async () => {
      const payment = makeInstallment({
        paymentType: PaymentType.FIRST_PAYMENT,
      });
      tenant.payment.findFirst.mockResolvedValueOnce(payment);
      tx.payment.findUniqueOrThrow.mockResolvedValueOnce({
        ...payment,
        status: PaymentTransactionStatus.FAILED,
      });
      // rejectPayment uses tx.childEnrollment.update for the FAILED enrollment
      (tx.childEnrollment.update as jest.Mock).mockResolvedValue({});

      await service.rejectPayment('pay-1', SCHOOL_ID, actor);

      expect(tx.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentTransactionStatus.FAILED,
          }),
        }),
      );
      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.PAYMENT_REJECTED }),
        tx,
      );
    });

    it('does NOT touch enrollment status for an INSTALLMENT rejection', async () => {
      const payment = makeInstallment();
      tenant.payment.findFirst.mockResolvedValueOnce(payment);
      tx.payment.findUniqueOrThrow.mockResolvedValueOnce(payment);

      await service.rejectPayment('pay-1', SCHOOL_ID, actor);

      expect(tx.childEnrollment.update).not.toHaveBeenCalled();
    });

    it('is idempotent under concurrency: count===0 -> BadRequest', async () => {
      tenant.payment.findFirst.mockResolvedValueOnce(makeInstallment());
      tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.rejectPayment('pay-1', SCHOOL_ID, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------- reverse
  describe('reversePayment', () => {
    it('restores the balance with an atomic increment and reopens a COMPLETED enrollment', async () => {
      const payment = makeInstallment({
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
        amountPaid: 50_000,
      });
      tenant.payment.findFirst.mockResolvedValueOnce(payment);
      tx.childEnrollment.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'enr-1',
        remainingBalance: 0,
        totalSchoolFee: 150_000,
        paymentStatus: PaymentStatus.COMPLETED,
      });
      // increment restores below the cap -> no clamp needed
      tx.childEnrollment.update.mockResolvedValueOnce({
        id: 'enr-1',
        remainingBalance: 50_000,
      });
      tx.payment.findUniqueOrThrow.mockResolvedValueOnce({
        ...payment,
        status: PaymentTransactionStatus.REVERSED,
        isConfirmed: false,
      });

      await service.reversePayment('pay-1', SCHOOL_ID, actor, 'duplicate');

      // guarded flip only a confirmed SUCCESS installment
      expect(tx.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isConfirmed: true,
            status: PaymentTransactionStatus.SUCCESS,
            paymentType: PaymentType.INSTALLMENT,
          }),
          data: {
            status: PaymentTransactionStatus.REVERSED,
            isConfirmed: false,
          },
        }),
      );
      // atomic increment + reopen COMPLETED -> ACTIVE
      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: {
          remainingBalance: { increment: 50_000 },
          paymentStatus: PaymentStatus.ACTIVE,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PAYMENT_REVERSED,
          reason: 'duplicate',
          metadata: expect.objectContaining({ reopened: true }),
        }),
        tx,
      );
    });

    it('clamps the restored balance so it can never exceed the total school fee', async () => {
      const payment = makeInstallment({
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
        amountPaid: 50_000,
      });
      tenant.payment.findFirst.mockResolvedValueOnce(payment);
      tx.childEnrollment.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'enr-1',
        remainingBalance: 140_000,
        totalSchoolFee: 150_000,
        paymentStatus: PaymentStatus.ACTIVE,
      });
      // increment overshoots the cap (190k > 150k)
      tx.childEnrollment.update
        .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: 190_000 })
        .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: 150_000 });
      tx.payment.findUniqueOrThrow.mockResolvedValueOnce(payment);

      await service.reversePayment('pay-1', SCHOOL_ID, actor);

      // second update clamps down to the total fee
      expect(tx.childEnrollment.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'enr-1' },
        data: { remainingBalance: 150_000 },
      });
    });

    it('refuses to reverse when no confirmed installment matches (guard)', async () => {
      tenant.payment.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.reversePayment('pay-1', SCHOOL_ID, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is idempotent under a double-reverse: count===0 -> BadRequest, balance untouched', async () => {
      const payment = makeInstallment({
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
      });
      tenant.payment.findFirst.mockResolvedValueOnce(payment);
      tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.reversePayment('pay-1', SCHOOL_ID, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.childEnrollment.update).not.toHaveBeenCalled();
    });
  });
});
