import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  PaymentReceiver,
  AuditAction,
} from '../generated/prisma/client';

/**
 * CHARACTERIZATION suite for LedgerService — the single owner of money-state
 * transitions (Milestone 3). These assertions were written test-first against
 * the pre-extraction code (in schools/admin/enrollment) and retargeted here
 * unchanged once the logic moved, proving the extraction is behavior-preserving.
 *
 * The $transaction mock EXECUTES its callback against a `tx` double, so the
 * guarded writes, atomic balance inc/dec, clamp branches, audit payloads, and
 * idempotency (count===0) no-ops are all exercised.
 */
describe('LedgerService (characterization)', () => {
  let tx: {
    payment: {
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findFirst?: jest.Mock;
    };
    childEnrollment: {
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      findUnique?: jest.Mock;
      updateMany?: jest.Mock;
    };
    notification: { create: jest.Mock };
  };
  let prisma: {
    withTenant: jest.Mock;
    payment: { findFirst: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tenant: {
    payment: { findFirst: jest.Mock };
    childEnrollment?: { findFirst: jest.Mock };
  };
  let notifications: { create: jest.Mock };
  let events: {
    emitPaymentsChanged: jest.Mock;
    emitEnrollmentsChanged: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let metrics: { recordPaymentOutcome: jest.Mock };
  let service: LedgerService;

  const SCHOOL_ID = 'school-1';
  const actor = { userId: 'owner-1', role: 'SCHOOL_OWNER' } as never;
  const adminActor = { userId: 'admin-1', role: 'SUPER_ADMIN' } as never;

  beforeEach(() => {
    tx = {
      payment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      childEnrollment: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
    };
    tenant = { payment: { findFirst: jest.fn() } };
    prisma = {
      withTenant: jest.fn().mockReturnValue(tenant),
      payment: { findFirst: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    events = {
      emitPaymentsChanged: jest.fn(),
      emitEnrollmentsChanged: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    metrics = { recordPaymentOutcome: jest.fn() };

    service = new LedgerService(
      prisma as never,
      notifications as never,
      events as never,
      audit as never,
      metrics as never,
    );
  });

  // ============================ installments ============================
  describe('installments (confirm / reject / reverse)', () => {
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
        expect(tx.childEnrollment.update).toHaveBeenCalledWith({
          where: { id: 'enr-1' },
          data: { remainingBalance: { decrement: 50_000 } },
        });
        expect(tx.childEnrollment.update).toHaveBeenCalledTimes(1);
        expect(result.amount).toBe(500);
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
        tx.childEnrollment.update
          .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: -20_000 })
          .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: 0 });
        tx.payment.findUniqueOrThrow.mockResolvedValueOnce(payment);

        await service.confirmPayment('pay-1', SCHOOL_ID, actor);

        expect(tx.childEnrollment.update).toHaveBeenNthCalledWith(2, {
          where: { id: 'enr-1' },
          data: { remainingBalance: 0, paymentStatus: PaymentStatus.COMPLETED },
        });
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
        tenant.payment.findFirst.mockResolvedValueOnce(null);

        await expect(
          service.confirmPayment('foreign-pay', SCHOOL_ID, actor),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.withTenant).toHaveBeenCalledWith(SCHOOL_ID);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

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
        tx.childEnrollment.update
          .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: 190_000 })
          .mockResolvedValueOnce({ id: 'enr-1', remainingBalance: 150_000 });
        tx.payment.findUniqueOrThrow.mockResolvedValueOnce(payment);

        await service.reversePayment('pay-1', SCHOOL_ID, actor);

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

  // ========================= first payments (admin) =========================
  describe('first payments (settle / reject)', () => {
    function makeFirstPayment(overrides: Record<string, unknown> = {}) {
      return {
        id: 'pay-1',
        enrollmentId: 'enr-1',
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
        amountPaid: 100_000,
        enrollment: {
          id: 'enr-1',
          schoolId: 'school-1',
          paymentStatus: PaymentStatus.PENDING,
          school: { name: 'Acme School', ownerId: 'owner-1' },
          child: { fullName: 'Ada Lovelace', parent: { userId: 'parent-1' } },
        },
        ...overrides,
      };
    }

    describe('settleFirstPayment', () => {
      it('confirms the payment and ACTIVATES the enrollment, with owner + parent notifications', async () => {
        prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());

        const result = await service.settleFirstPayment('pay-1', adminActor);

        expect(tx.payment.updateMany).toHaveBeenCalledWith({
          where: { id: 'pay-1', isConfirmed: false },
          data: { isConfirmed: true, status: PaymentTransactionStatus.SUCCESS },
        });
        expect(tx.childEnrollment.update).toHaveBeenCalledWith({
          where: { id: 'enr-1' },
          data: { paymentStatus: PaymentStatus.ACTIVE },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.FIRST_PAYMENT_SETTLED,
          }),
          tx,
        );
        expect(tx.notification.create).toHaveBeenCalledTimes(2);
        expect(result).toEqual(expect.objectContaining({ paymentId: 'pay-1' }));
      });

      it('404s when the payment is missing/already settled (pre-tx)', async () => {
        prisma.payment.findFirst.mockResolvedValueOnce(null);

        await expect(
          service.settleFirstPayment('pay-1', adminActor),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('404s when a concurrent settle won the race (count===0)', async () => {
        prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());
        tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(
          service.settleFirstPayment('pay-1', adminActor),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    describe('rejectFirstPayment', () => {
      it('fails the payment AND the enrollment, with owner + parent notifications', async () => {
        prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());

        const result = await service.rejectFirstPayment('pay-1', adminActor);

        expect(tx.payment.updateMany).toHaveBeenCalledWith({
          where: { id: 'pay-1', isConfirmed: false },
          data: { status: PaymentTransactionStatus.FAILED },
        });
        expect(tx.childEnrollment.update).toHaveBeenCalledWith({
          where: { id: 'enr-1' },
          data: { paymentStatus: PaymentStatus.FAILED },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.FIRST_PAYMENT_REJECTED,
          }),
          tx,
        );
        expect(tx.notification.create).toHaveBeenCalledTimes(2);
        expect(result).toEqual(expect.objectContaining({ paymentId: 'pay-1' }));
      });

      it('404s on a concurrent reject (count===0)', async () => {
        prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());
        tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(
          service.rejectFirstPayment('pay-1', adminActor),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(tx.childEnrollment.update).not.toHaveBeenCalled();
      });
    });
  });

  // ========================= paystack reconcile =========================
  describe('paystack (reconcile / fail)', () => {
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

    describe('reconcilePaystackPayment', () => {
      it('flips PENDING -> SUCCESS, activates the enrollment, and records the fee delta', async () => {
        prisma.payment.findUnique.mockResolvedValueOnce(makePayment());

        const result = await service.reconcilePaystackPayment(
          'ref-1',
          1_800,
          null,
        );

        expect(tx.payment.updateMany).toHaveBeenCalledWith({
          where: { id: 'pay-1', status: PaymentTransactionStatus.PENDING },
          data: expect.objectContaining({
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
            actualPaystackFee: 1_800,
          }),
        });
        expect(tx.childEnrollment.update).toHaveBeenCalledWith({
          where: { id: 'enr-1' },
          data: { paymentStatus: PaymentStatus.ACTIVE },
        });
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

        const result = await service.reconcilePaystackPayment(
          'nope',
          null,
          null,
        );

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

  // ===================== enrollment lifecycle =====================
  describe('enrollment lifecycle (confirmFirstPayment / markEnrollmentAsDefaulted)', () => {
    describe('confirmFirstPayment', () => {
      function makeEnrollment(overrides: Record<string, unknown> = {}) {
        return {
          id: 'enr-1',
          schoolId: SCHOOL_ID,
          paymentStatus: PaymentStatus.PENDING,
          className: 'JSS1',
          school: { name: 'Acme School' },
          child: {
            fullName: 'Ada Lovelace',
            parent: { userId: 'parent-1', user: { id: 'u-1' } },
          },
          ...overrides,
        };
      }

      it('confirms the pending first payment, activates the enrollment, audits + emits', async () => {
        tx.childEnrollment.findUnique = jest
          .fn()
          .mockResolvedValueOnce(makeEnrollment());
        tx.payment.findFirst = jest.fn().mockResolvedValueOnce({
          id: 'pay-1',
          isConfirmed: false,
          amountPaid: 80_000,
        });
        tx.childEnrollment.updateMany = jest
          .fn()
          .mockResolvedValue({ count: 1 });

        const result = await service.confirmFirstPayment(
          'enr-1',
          SCHOOL_ID,
          actor,
        );

        expect(tx.payment.updateMany).toHaveBeenCalledWith({
          where: { id: 'pay-1', isConfirmed: false },
          data: expect.objectContaining({
            isConfirmed: true,
            status: PaymentTransactionStatus.SUCCESS,
          }),
        });
        expect(tx.childEnrollment.updateMany).toHaveBeenCalledWith({
          where: { id: 'enr-1', paymentStatus: PaymentStatus.PENDING },
          data: { paymentStatus: PaymentStatus.ACTIVE },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.FIRST_PAYMENT_CONFIRMED,
          }),
          tx,
        );
        expect(events.emitEnrollmentsChanged).toHaveBeenCalledWith({
          parentUserId: 'parent-1',
          schoolId: SCHOOL_ID,
          notifyAdmins: true,
        });
        expect(result).toEqual({
          message: 'First payment confirmed and enrollment activated',
        });
      });

      it('rejects an enrollment that belongs to another school (tenant guard)', async () => {
        tx.childEnrollment.findUnique = jest
          .fn()
          .mockResolvedValueOnce(makeEnrollment({ schoolId: 'other-school' }));
        tx.payment.findFirst = jest.fn();

        await expect(
          service.confirmFirstPayment('enr-1', SCHOOL_ID, actor),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(tx.payment.updateMany).not.toHaveBeenCalled();
      });

      it('rejects when the enrollment is not PENDING', async () => {
        tx.childEnrollment.findUnique = jest
          .fn()
          .mockResolvedValueOnce(
            makeEnrollment({ paymentStatus: PaymentStatus.ACTIVE }),
          );
        tx.payment.findFirst = jest.fn();

        await expect(
          service.confirmFirstPayment('enr-1', SCHOOL_ID, actor),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('is idempotent: a concurrent confirm (count===0) throws, no activation', async () => {
        tx.childEnrollment.findUnique = jest
          .fn()
          .mockResolvedValueOnce(makeEnrollment());
        tx.payment.findFirst = jest.fn().mockResolvedValueOnce({
          id: 'pay-1',
          isConfirmed: false,
          amountPaid: 80_000,
        });
        tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });
        tx.childEnrollment.updateMany = jest.fn();

        await expect(
          service.confirmFirstPayment('enr-1', SCHOOL_ID, actor),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(tx.childEnrollment.updateMany).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    describe('markEnrollmentAsDefaulted', () => {
      function makeEnrollment(overrides: Record<string, unknown> = {}) {
        return {
          id: 'enr-1',
          remainingBalance: 30_000,
          paymentStatus: PaymentStatus.ACTIVE,
          className: 'JSS1',
          school: { name: 'Acme School' },
          child: { fullName: 'Ada Lovelace', parent: { userId: 'parent-1' } },
          ...overrides,
        };
      }

      it('marks DEFAULTED (tenant-scoped), audits, notifies, and emits', async () => {
        tenant.childEnrollment = {
          findFirst: jest.fn().mockResolvedValueOnce(makeEnrollment()),
        } as never;
        tx.childEnrollment.update.mockResolvedValueOnce({
          id: 'enr-1',
          paymentStatus: PaymentStatus.DEFAULTED,
        });

        const result = await service.markEnrollmentAsDefaulted(
          'enr-1',
          SCHOOL_ID,
          actor,
        );

        expect(prisma.withTenant).toHaveBeenCalledWith(SCHOOL_ID);
        expect(tx.childEnrollment.update).toHaveBeenCalledWith({
          where: { id: 'enr-1' },
          data: { paymentStatus: PaymentStatus.DEFAULTED },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.ENROLLMENT_DEFAULTED,
            metadata: expect.objectContaining({ remainingBalance: 30_000 }),
          }),
          tx,
        );
        expect(events.emitEnrollmentsChanged).toHaveBeenCalledWith({
          parentUserId: 'parent-1',
          schoolId: SCHOOL_ID,
          notifyAdmins: true,
        });
        expect(result).toEqual(
          expect.objectContaining({ paymentStatus: PaymentStatus.DEFAULTED }),
        );
      });

      it('throws when the enrollment is not found in the tenant scope', async () => {
        tenant.childEnrollment = {
          findFirst: jest.fn().mockResolvedValueOnce(null),
        } as never;

        await expect(
          service.markEnrollmentAsDefaulted('missing', SCHOOL_ID, actor),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('markEnrollmentDefaultedBySweep (system batch)', () => {
      function makeSweepRow(overrides: Record<string, unknown> = {}) {
        return {
          id: 'enr-1',
          schoolId: SCHOOL_ID,
          remainingBalance: 30_000,
          child: { fullName: 'Ada Lovelace', parent: { userId: 'parent-1' } },
          school: { name: 'Acme School' },
          ...overrides,
        };
      }

      it('guards on ACTIVE+balance>0, records a null-actor system audit, notifies in-tx, emits, returns true', async () => {
        tx.childEnrollment.updateMany = jest
          .fn()
          .mockResolvedValueOnce({ count: 1 });

        const flipped =
          await service.markEnrollmentDefaultedBySweep(makeSweepRow());

        expect(tx.childEnrollment.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'enr-1',
            paymentStatus: PaymentStatus.ACTIVE,
            remainingBalance: { gt: 0 },
          },
          data: { paymentStatus: PaymentStatus.DEFAULTED },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.ENROLLMENT_DEFAULTED,
            actor: null,
            metadata: expect.objectContaining({
              source: 'scheduled-defaulter-detection',
            }),
          }),
          tx,
        );
        expect(tx.notification.create).toHaveBeenCalledTimes(1);
        expect(events.emitEnrollmentsChanged).toHaveBeenCalledWith({
          parentUserId: 'parent-1',
          schoolId: SCHOOL_ID,
          notifyAdmins: true,
        });
        expect(flipped).toBe(true);
      });

      it('returns false without audit/notify/emit when the row already changed (count===0)', async () => {
        tx.childEnrollment.updateMany = jest
          .fn()
          .mockResolvedValueOnce({ count: 0 });

        const flipped =
          await service.markEnrollmentDefaultedBySweep(makeSweepRow());

        expect(flipped).toBe(false);
        expect(audit.record).not.toHaveBeenCalled();
        expect(tx.notification.create).not.toHaveBeenCalled();
        expect(events.emitEnrollmentsChanged).not.toHaveBeenCalled();
      });
    });
  });
});
