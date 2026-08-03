import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  Prisma,
} from '../generated/prisma/client';

/**
 * The manual-approval guards on Paystack-collected first payments, and what
 * happens when a real charge lands on a payment we had already closed.
 *
 * Background — the defect these lock down: a Paystack first payment row is created
 * PENDING at *initiation*, before the parent has typed a card number. It matched
 * every "pending first payment" query, so the admin approvals queue offered a
 * Settle button on money that had not been collected. Settling it activated the
 * enrollment and credited the deposit; worse, the flip meant the genuine
 * `charge.success` that arrived later found a non-PENDING row and no-oped, so the
 * real charge was never audited or fee-reconciled. Rejecting had the mirror
 * failure: the parent completes the popup, Paystack captures and splits the money,
 * and our enrollment stays FAILED forever.
 */
describe('LedgerService — Paystack first-payment guards', () => {
  let prisma: {
    payment: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    childEnrollment: { findUnique: jest.Mock; update: jest.Mock };
    user: { findMany: jest.Mock };
    notification: { create: jest.Mock };
    webhookEvent: { create: jest.Mock; delete: jest.Mock };
    $transaction: jest.Mock;
  };
  let notifications: { create: jest.Mock };
  let events: {
    emitPaymentsChanged: jest.Mock;
    emitEnrollmentsChanged: jest.Mock;
    pushNotification: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let metrics: {
    recordPaymentOutcome: jest.Mock;
    recordPaystackFeeDelta: jest.Mock;
    recordReconcileConflict: jest.Mock;
  };
  let service: LedgerService;

  const ACTOR = { userId: 'admin-1', role: 'SUPER_ADMIN' } as never;

  beforeEach(() => {
    prisma = {
      payment: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      childEnrollment: { findUnique: jest.fn(), update: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]) },
      notification: { create: jest.fn() },
      webhookEvent: {
        create: jest.fn().mockResolvedValue({ id: 'we-1' }),
        delete: jest.fn().mockResolvedValue({ id: 'we-1' }),
      },
      $transaction: jest.fn(),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    events = {
      emitPaymentsChanged: jest.fn(),
      emitEnrollmentsChanged: jest.fn(),
      pushNotification: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    metrics = {
      recordPaymentOutcome: jest.fn(),
      recordPaystackFeeDelta: jest.fn(),
      recordReconcileConflict: jest.fn(),
    };
    service = new LedgerService(
      prisma as never,
      notifications as never,
      events as never,
      audit as never,
      metrics as never,
    );
  });

  describe('settleFirstPayment', () => {
    it('scopes the lookup to MANUAL first payments only', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);

      await expect(service.settleFirstPayment('pay-1', ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      // The filter is the whole fix: without `paystackReference: null` an
      // uncollected card payment is settleable by an admin.
      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'pay-1',
            paymentType: PaymentType.FIRST_PAYMENT,
            isConfirmed: false,
            paystackReference: null,
          }),
        }),
      );
    });

    it('changes no money state when only a card payment matches the id', async () => {
      // Simulates the real query result for a Paystack row: filtered out → null.
      prisma.payment.findFirst.mockResolvedValue(null);

      await expect(service.settleFirstPayment('pay-1', ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(metrics.recordPaymentOutcome).not.toHaveBeenCalled();
    });
  });

  describe('rejectFirstPayment', () => {
    it('scopes the lookup to MANUAL first payments only', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);

      await expect(service.rejectFirstPayment('pay-1', ACTOR)).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            paymentType: PaymentType.FIRST_PAYMENT,
            isConfirmed: false,
            paystackReference: null,
          }),
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('confirmFirstPayment (school owner)', () => {
    const enrollment = {
      id: 'enr-1',
      schoolId: 'school-1',
      paymentStatus: PaymentStatus.PENDING,
      remainingBalance: 100_000,
      child: { fullName: 'Kid A', parent: { userId: 'parent-1', user: {} } },
      school: { name: 'Acme', ownerId: 'owner-1' },
    };

    const runTx = () => {
      prisma.$transaction.mockImplementation(
        async (fn: (tx: unknown) => unknown) => fn(prisma),
      );
    };

    it('refuses a card first payment with an explanation, not a bare not-found', async () => {
      runTx();
      prisma.childEnrollment.findUnique.mockResolvedValue(enrollment);
      // No manual payment matches...
      prisma.payment.findFirst
        .mockResolvedValueOnce(null)
        // ...but an unconfirmed Paystack one exists.
        .mockResolvedValueOnce({ id: 'pay-card' });

      await expect(
        service.confirmFirstPayment('enr-1', 'school-1', ACTOR),
      ).rejects.toThrow(/collected by card and is confirmed automatically/i);

      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(prisma.childEnrollment.update).not.toHaveBeenCalled();
    });

    it('still reports "no pending first payment" when nothing is outstanding', async () => {
      runTx();
      prisma.childEnrollment.findUnique.mockResolvedValue(enrollment);
      prisma.payment.findFirst.mockResolvedValue(null); // neither manual nor card

      await expect(
        service.confirmFirstPayment('enr-1', 'school-1', ACTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('looks for the manual payment with paystackReference: null', async () => {
      runTx();
      prisma.childEnrollment.findUnique.mockResolvedValue(enrollment);
      prisma.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.confirmFirstPayment('enr-1', 'school-1', ACTOR),
      ).rejects.toThrow();

      expect(prisma.payment.findFirst).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            enrollmentId: 'enr-1',
            paymentType: PaymentType.FIRST_PAYMENT,
            isConfirmed: false,
            paystackReference: null,
          }),
        }),
      );
    });
  });

  describe('reconcilePaystackPayment — book-vs-bank conflict', () => {
    const conflictPayment = (status: PaymentTransactionStatus) => ({
      id: 'pay-1',
      status,
      amountPaid: 2_750_000,
      schoolId: 'school-1',
      enrollmentId: 'enr-1',
      paystackFee: 52_030,
      schoolAmount: 2_500_000,
      enrollment: {
        id: 'enr-1',
        remainingBalance: 10_000_000,
        school: { name: 'Acme', ownerId: 'owner-1' },
        child: { fullName: 'Kid A', parent: { userId: 'parent-1' } },
      },
    });

    it.each([
      PaymentTransactionStatus.FAILED,
      PaymentTransactionStatus.REVERSED,
    ])(
      'holds state and escalates when a success arrives for a %s payment',
      async (status) => {
        prisma.payment.findUnique.mockResolvedValue(conflictPayment(status));

        const result = await service.reconcilePaystackPayment(
          'lopay_ref',
          52_030,
          null,
        );

        // Never claim success: the old code returned `alreadyProcessed: true` here.
        expect(result).toEqual({
          reconciled: false,
          reason: 'status_conflict',
          status,
        });
        // And touch nothing — a human decides whether to settle or refund.
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.childEnrollment.update).not.toHaveBeenCalled();
      },
    );

    it('notifies every super admin with the reference and amount', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
      prisma.payment.findUnique.mockResolvedValue(
        conflictPayment(PaymentTransactionStatus.FAILED),
      );

      await service.reconcilePaystackPayment('lopay_ref', 52_030, null);

      expect(notifications.create).toHaveBeenCalledTimes(2);
      const [first] = notifications.create.mock.calls[0] as [
        { userId: string; message: string; title: string },
      ];
      expect(first.userId).toBe('a1');
      expect(first.message).toContain('lopay_ref');
      expect(first.message).toContain('₦27,500'); // the amount, in naira
    });

    it('counts the conflict on the metric labelled with our local status', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        conflictPayment(PaymentTransactionStatus.FAILED),
      );

      await service.reconcilePaystackPayment('lopay_ref', 52_030, null);

      expect(metrics.recordReconcileConflict).toHaveBeenCalledWith(
        PaymentTransactionStatus.FAILED,
      );
    });

    it('leaves the ordinary already-SUCCESS replay path untouched', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        conflictPayment(PaymentTransactionStatus.SUCCESS),
      );

      const result = await service.reconcilePaystackPayment(
        'lopay_ref',
        52_030,
        null,
      );

      expect(result).toEqual({ reconciled: true, alreadyProcessed: true });
      expect(metrics.recordReconcileConflict).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('alerts AT MOST ONCE per reference', async () => {
      // verify-on-return is a GET the parent can repeat by refreshing; without a
      // durable guard one conflicted payment would bury every admin in ALERTs.
      prisma.payment.findUnique.mockResolvedValue(
        conflictPayment(PaymentTransactionStatus.FAILED),
      );
      prisma.webhookEvent.create.mockRejectedValue(
        Object.assign(
          new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: '6',
          }),
          { meta: { target: ['dedupeKey'] } },
        ),
      );

      const result = await service.reconcilePaystackPayment(
        'lopay_ref',
        52_030,
        null,
      );

      expect(result).toEqual({
        reconciled: false,
        reason: 'status_conflict',
        status: PaymentTransactionStatus.FAILED,
      });
      expect(notifications.create).not.toHaveBeenCalled();
      expect(metrics.recordReconcileConflict).not.toHaveBeenCalled();
    });

    it('records the conflict durably, keyed on the reference', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        conflictPayment(PaymentTransactionStatus.REVERSED),
      );

      await service.reconcilePaystackPayment('lopay_ref', 52_030, null);

      expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            provider: 'paystack',
            eventType: 'reconcile.conflict',
            dedupeKey: 'reconcile.conflict:lopay_ref',
            reference: 'lopay_ref',
          }),
        }),
      );
    });

    it('rethrows a non-dedupe database error instead of swallowing it', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        conflictPayment(PaymentTransactionStatus.FAILED),
      );
      prisma.webhookEvent.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.reconcilePaystackPayment('lopay_ref', 52_030, null),
      ).rejects.toThrow('db down');
    });

    it('does not promise an in-app settle button it no longer offers', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        conflictPayment(PaymentTransactionStatus.FAILED),
      );

      await service.reconcilePaystackPayment('lopay_ref', 52_030, null);

      const [alert] = notifications.create.mock.calls[0] as [
        { message: string },
      ];
      expect(alert.message).toMatch(/Paystack dashboard/i);
      expect(alert.message).toMatch(/will not activate/i);
    });

    /*
     * The claim is written BEFORE delivery (at-most-once under three racing
     * callers), so a fan-out that fails outright would otherwise mark the break
     * "escalated" while no human ever heard about it — a permanently lost alert
     * on the one path that exists to demand a human. These pin the recovery.
     */
    describe('alert delivery failure', () => {
      it('releases the claim when NO admin could be notified, so a replay re-alerts', async () => {
        prisma.user.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
        prisma.payment.findUnique.mockResolvedValue(
          conflictPayment(PaymentTransactionStatus.FAILED),
        );
        notifications.create.mockRejectedValue(new Error('notify down'));

        const result = await service.reconcilePaystackPayment(
          'lopay_ref',
          52_030,
          null,
        );

        // The caller still gets the conflict outcome — a delivery failure must
        // not turn into a webhook 500 (Paystack would retry a non-retryable event).
        expect(result).toEqual({
          reconciled: false,
          reason: 'status_conflict',
          status: PaymentTransactionStatus.FAILED,
        });
        expect(prisma.webhookEvent.delete).toHaveBeenCalledWith({
          where: { dedupeKey: 'reconcile.conflict:lopay_ref' },
        });
      });

      it('keeps the claim when at least one admin heard about it', async () => {
        prisma.user.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
        prisma.payment.findUnique.mockResolvedValue(
          conflictPayment(PaymentTransactionStatus.FAILED),
        );
        // One bad row must not sink the batch — nor re-arm the dedupe.
        notifications.create
          .mockRejectedValueOnce(new Error('one admin row is broken'))
          .mockResolvedValueOnce(undefined);

        await service.reconcilePaystackPayment('lopay_ref', 52_030, null);

        expect(notifications.create).toHaveBeenCalledTimes(2);
        expect(prisma.webhookEvent.delete).not.toHaveBeenCalled();
      });

      it('releases the claim when the admin lookup itself fails', async () => {
        prisma.user.findMany.mockRejectedValue(new Error('db blip'));
        prisma.payment.findUnique.mockResolvedValue(
          conflictPayment(PaymentTransactionStatus.REVERSED),
        );

        const result = await service.reconcilePaystackPayment(
          'lopay_ref',
          52_030,
          null,
        );

        expect(result).toEqual({
          reconciled: false,
          reason: 'status_conflict',
          status: PaymentTransactionStatus.REVERSED,
        });
        expect(prisma.webhookEvent.delete).toHaveBeenCalledWith({
          where: { dedupeKey: 'reconcile.conflict:lopay_ref' },
        });
      });

      it('does not loop-release when there are simply no admins to tell', async () => {
        prisma.user.findMany.mockResolvedValue([]);
        prisma.payment.findUnique.mockResolvedValue(
          conflictPayment(PaymentTransactionStatus.FAILED),
        );

        await service.reconcilePaystackPayment('lopay_ref', 52_030, null);

        // Zero recipients is a deployment state, not a delivery failure —
        // releasing here would re-run the whole escalation on every replay.
        expect(prisma.webhookEvent.delete).not.toHaveBeenCalled();
      });

      it('swallows a failed claim release rather than failing the webhook', async () => {
        prisma.user.findMany.mockResolvedValue([{ id: 'a1' }]);
        prisma.payment.findUnique.mockResolvedValue(
          conflictPayment(PaymentTransactionStatus.FAILED),
        );
        notifications.create.mockRejectedValue(new Error('notify down'));
        prisma.webhookEvent.delete.mockRejectedValue(new Error('db down too'));

        await expect(
          service.reconcilePaystackPayment('lopay_ref', 52_030, null),
        ).resolves.toEqual({
          reconciled: false,
          reason: 'status_conflict',
          status: PaymentTransactionStatus.FAILED,
        });
      });
    });

    it('still reports an unknown reference as unknown', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      const result = await service.reconcilePaystackPayment('nope', null, null);

      expect(result).toEqual({
        reconciled: false,
        reason: 'unknown_reference',
      });
      expect(metrics.recordReconcileConflict).not.toHaveBeenCalled();
    });
  });
});
