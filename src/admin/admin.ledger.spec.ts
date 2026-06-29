import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  PaymentReceiver,
  AuditAction,
} from '../generated/prisma/client';

/**
 * CHARACTERIZATION suite for the first-payment money-state transitions owned
 * (today) by AdminService: settleFirstPayment / rejectFirstPayment.
 *
 * Milestone 3 moves these into the LedgerService. These lock the CURRENT
 * behavior — guarded flip → enrollment activate/fail → audit → in-tx
 * notifications — so the extraction stays behavior-preserving. Written
 * test-first (green pre-refactor).
 */
describe('AdminService — first-payment ledger (characterization)', () => {
  let tx: {
    payment: { updateMany: jest.Mock };
    childEnrollment: { update: jest.Mock };
    notification: { create: jest.Mock };
  };
  let prisma: {
    payment: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let service: AdminService;

  const actor = { userId: 'admin-1', role: 'SUPER_ADMIN' } as never;

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

  beforeEach(() => {
    tx = {
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      childEnrollment: { update: jest.fn().mockResolvedValue({}) },
      notification: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      payment: { findFirst: jest.fn() },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    service = new AdminService(
      prisma as never,
      {} as never, // notificationsService (settle/reject notify in-tx)
      {} as never, // documentsService
      audit as never,
      {} as never, // paystack
      {} as never, // authService
    );
  });

  describe('settleFirstPayment', () => {
    it('confirms the payment and ACTIVATES the enrollment, with owner + parent notifications', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());

      const result = await service.settleFirstPayment('pay-1', actor);

      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', isConfirmed: false },
        data: {
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
        },
      });
      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: { paymentStatus: PaymentStatus.ACTIVE },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.FIRST_PAYMENT_SETTLED }),
        tx,
      );
      // owner + parent notified inside the tx
      expect(tx.notification.create).toHaveBeenCalledTimes(2);
      expect(result).toEqual(expect.objectContaining({ paymentId: 'pay-1' }));
    });

    it('404s when the payment is missing/already settled (pre-tx)', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.settleFirstPayment('pay-1', actor),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s when a concurrent settle won the race (count===0)', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());
      tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.settleFirstPayment('pay-1', actor),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('rejectFirstPayment', () => {
    it('fails the payment AND the enrollment, with owner + parent notifications', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());

      const result = await service.rejectFirstPayment('pay-1', actor);

      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', isConfirmed: false },
        data: { status: PaymentTransactionStatus.FAILED },
      });
      expect(tx.childEnrollment.update).toHaveBeenCalledWith({
        where: { id: 'enr-1' },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.FIRST_PAYMENT_REJECTED }),
        tx,
      );
      expect(tx.notification.create).toHaveBeenCalledTimes(2);
      expect(result).toEqual(expect.objectContaining({ paymentId: 'pay-1' }));
    });

    it('404s on a concurrent reject (count===0)', async () => {
      prisma.payment.findFirst.mockResolvedValueOnce(makeFirstPayment());
      tx.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.rejectFirstPayment('pay-1', actor),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.childEnrollment.update).not.toHaveBeenCalled();
    });
  });
});
