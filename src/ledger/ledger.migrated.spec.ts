import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  PaymentReceiver,
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  UserRole,
} from '../generated/prisma/client';
import { LedgerService } from './ledger.service';

const ACTOR = { userId: 'owner-1', role: UserRole.SCHOOL_OWNER };
const naira = (n: number) => n * 100;

/**
 * The two money paths this feature adds to the ledger.
 *
 * `recordMigratedEnrollment` writes a plan's opening position; `amendMigratedPayment`
 * restates it. Both are the ledger's business rather than the invite service's,
 * and both are asserted here on what they WRITE — the row shapes, the balance
 * arithmetic, the audit entry — because those are the values a family's plan is
 * later derived from.
 */
describe('LedgerService — migrated money', () => {
  let tx: {
    childEnrollment: Record<string, jest.Mock>;
    payment: Record<string, jest.Mock>;
    enrollmentInvite: Record<string, jest.Mock>;
    child: Record<string, jest.Mock>;
    $queryRaw: jest.Mock;
  };
  let prisma: Record<string, unknown>;
  let notifications: { create: jest.Mock };
  let events: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let metrics: Record<string, jest.Mock>;
  let ledger: LedgerService;

  const invite = {
    id: 'invite-1',
    schoolId: 'school-1',
    studentName: 'Ada Lovelace',
    className: 'Basic 1',
    totalSchoolFee: naira(100_000),
    amountAlreadyPaid: naira(40_000),
    installmentFrequency: 'MONTHLY' as const,
    planStartDate: new Date('2026-09-19T00:00:00.000Z'),
    termEndDate: new Date('2026-12-19T00:00:00.000Z'),
  };

  beforeEach(() => {
    tx = {
      childEnrollment: {
        create: jest.fn().mockResolvedValue({
          id: 'enrollment-1',
          remainingBalance: naira(60_000),
          paymentStatus: PaymentStatus.ACTIVE,
        }),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
      payment: {
        create: jest.fn().mockResolvedValue({ id: 'payment-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amountPaid: 0 } }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      enrollmentInvite: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      child: {
        upsert: jest.fn().mockResolvedValue({ id: 'child-1' }),
        delete: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn(),
    };
    prisma = {
      withTenant: jest.fn(),
      $transaction: jest.fn(
        async (fn: (c: unknown) => Promise<unknown>) => await fn(tx),
      ),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    events = {
      emitEnrollmentsChanged: jest.fn(),
      emitPaymentsChanged: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    metrics = { recordPaymentOutcome: jest.fn() };

    ledger = new LedgerService(
      prisma as never,
      notifications as never,
      events as never,
      audit as never,
      metrics as never,
    );
  });

  // ====================== recordMigratedEnrollment =========================

  describe('recordMigratedEnrollment', () => {
    const run = () =>
      ledger.recordMigratedEnrollment(tx as never, {
        invite,
        childId: 'child-1',
        parentUserId: 'parent-1',
        actor: ACTOR,
      });

    it('opens the plan owing only what is left after the prior payment', async () => {
      await run();

      expect(tx.childEnrollment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          totalSchoolFee: naira(100_000),
          firstPaymentPaid: naira(40_000),
          remainingBalance: naira(60_000),
          paymentStatus: PaymentStatus.ACTIVE,
        }),
      });
    });

    it('records the prior payment as a deposit, never as an installment', async () => {
      // The property the whole feature rests on: `installment-schedule.ts` sums
      // only INSTALLMENT rows when reconstructing the plan's opening balance.
      await run();

      expect(tx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          paymentType: PaymentType.MIGRATED_PAYMENT,
          receiver: PaymentReceiver.SCHOOL,
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          amountPaid: naira(40_000),
          schoolAmount: naira(40_000),
        }),
      });
    });

    it('charges no platform fee and reserves no deposit minimum', async () => {
      await run();

      expect(tx.payment.create.mock.calls[0][0].data.platformAmount).toBe(0);
      expect(tx.childEnrollment.create.mock.calls[0][0].data.platformFee).toBe(
        0,
      );
      expect(
        tx.childEnrollment.create.mock.calls[0][0].data.schoolMinimumFee,
      ).toBe(0);
    });

    it('anchors the schedule to the handover date, not to now', async () => {
      await run();

      expect(
        tx.childEnrollment.create.mock.calls[0][0].data.termStartDate,
      ).toBe(invite.planStartDate);
      // And the payment is dated to the handover, so history reads in order.
      // (`invite.planStartDate` is in the past, so the clamp below is a no-op
      // here — which is the ordinary case.)
      expect(tx.payment.create.mock.calls[0][0].data.paymentDate).toBe(
        invite.planStartDate,
      );
    });

    /**
     * A start date set for next term must not date the payment into the future.
     *
     * `validatePlanStart` permits up to MAX_PLAN_START_FUTURE_DAYS ahead so a
     * school can prepare next term's migrations early, which makes this an
     * ordinary path rather than a malformed one. The damage lands away from
     * this module: `AdminService.recentTransactions` orders by `paymentDate
     * desc` with no upper bound, so each such row outranks every genuinely
     * recent transaction on the platform dashboard until that date arrives.
     *
     * The plan's own anchor is NOT clamped — the schedule really does start
     * next term. Only the record of money that changed hands in the past is.
     */
    it('never dates the payment into the future, even for a next-term plan', async () => {
      const nextTerm = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

      await ledger.recordMigratedEnrollment(tx as never, {
        invite: { ...invite, planStartDate: nextTerm },
        childId: 'child-1',
        parentUserId: 'parent-1',
        actor: ACTOR,
      });

      const { paymentDate } = tx.payment.create.mock.calls[0][0].data;
      expect(paymentDate.getTime()).toBeLessThanOrEqual(Date.now());
      expect(paymentDate).not.toEqual(nextTerm);

      // The schedule still opens when the school said it would.
      expect(
        tx.childEnrollment.create.mock.calls[0][0].data.termStartDate,
      ).toBe(nextTerm);
    });

    it('completes a plan whose fees were already paid in full', async () => {
      tx.childEnrollment.create.mockResolvedValue({
        id: 'enrollment-1',
        remainingBalance: 0,
        paymentStatus: PaymentStatus.COMPLETED,
      });

      await ledger.recordMigratedEnrollment(tx as never, {
        invite: { ...invite, amountAlreadyPaid: invite.totalSchoolFee },
        childId: 'child-1',
        parentUserId: 'parent-1',
        actor: ACTOR,
      });

      expect(
        tx.childEnrollment.create.mock.calls[0][0].data.paymentStatus,
      ).toBe(PaymentStatus.COMPLETED);
    });

    it('does NOT notify the parent from inside the caller’s transaction', async () => {
      await run();

      // The claim can still roll back after this returns. A notification is a
      // row written through the non-transactional client, a socket emit and an
      // awaited FCM push — none of which can be undone. It belongs to
      // `announceMigratedEnrollment`, which runs after the commit.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('writes the audit row inside the caller’s transaction', async () => {
      await run();

      const [entry, client] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        action: AuditAction.ENROLLMENT_INVITE_CLAIMED,
        entityType: 'Payment',
        schoolId: 'school-1',
      });
      // Atomic with the change it describes — not a separate write that could
      // survive a rollback.
      expect(client).toBe(tx);
    });

    it('records that the figure was asserted by the school, not verified', async () => {
      await run();
      expect(audit.record.mock.calls[0][0].metadata).toMatchObject({
        assertedBySchool: true,
        enrollmentInviteId: 'invite-1',
        parentUserId: 'parent-1',
      });
    });

    it('emits nothing itself — the caller announces after commit', async () => {
      await run();
      expect(events.emitEnrollmentsChanged).not.toHaveBeenCalled();
      expect(metrics.recordPaymentOutcome).not.toHaveBeenCalled();
    });

    it('explains a duplicate claim rather than surfacing a constraint error', async () => {
      tx.childEnrollment.create.mockRejectedValue(
        prismaConflict(['enrollmentInviteId']),
      );

      await expect(run()).rejects.toThrow(/already been claimed/);
    });

    it('explains a child that already has a plan, and names the way out', async () => {
      tx.childEnrollment.create.mockRejectedValue(prismaConflict(['childId']));

      await expect(run()).rejects.toThrow(
        /already has a payment plan.*cancel this invite/is,
      );
    });

    it('does not swallow an unrelated database failure', async () => {
      tx.childEnrollment.create.mockRejectedValue(new Error('connection lost'));
      await expect(run()).rejects.toThrow('connection lost');
    });

    it('tolerates a P2002 whose meta is not an array of column names', async () => {
      const odd = prismaConflict([]);
      (odd as unknown as { meta: unknown }).meta = { target: { weird: true } };
      tx.childEnrollment.create.mockRejectedValue(odd);

      // Falls through to the default message rather than stringifying an object
      // into '[object Object]' and matching on it.
      await expect(run()).rejects.toThrow(/already has a payment plan/);
    });
  });

  describe('announceMigratedEnrollment', () => {
    const announce = (over: Record<string, unknown> = {}) =>
      ledger.announceMigratedEnrollment({
        parentUserId: 'parent-1',
        schoolId: 'school-1',
        schoolName: 'Acme Academy',
        studentName: 'Ada Lovelace',
        className: 'Basic 1',
        amountAlreadyPaid: naira(40_000),
        remainingBalance: naira(60_000),
        ...over,
      } as never);

    it('nudges both dashboards and counts the migration once', async () => {
      await announce();

      const targets = {
        parentUserId: 'parent-1',
        schoolId: 'school-1',
        notifyAdmins: true,
      };
      expect(events.emitEnrollmentsChanged).toHaveBeenCalledWith(targets);
      expect(events.emitPaymentsChanged).toHaveBeenCalledWith(targets);
      expect(metrics.recordPaymentOutcome).toHaveBeenCalledWith('confirmed', {
        type: PaymentType.MIGRATED_PAYMENT,
        receiver: PaymentReceiver.SCHOOL,
      });
    });

    it('tells the parent what was credited and what is left', async () => {
      await announce();

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'parent-1',
          message: expect.stringContaining('₦40,000.00'),
        }),
      );
      expect(notifications.create.mock.calls[0][0].message).toMatch(
        /₦60,000\.00 remains/,
      );
    });

    it('says the term is settled when nothing is left', async () => {
      await announce({ remainingBalance: 0 });

      expect(notifications.create.mock.calls[0][0].message).toMatch(
        /fully paid/,
      );
    });

    it('does not announce “₦0 already paid” when nothing was paid yet', async () => {
      // A school may migrate a family that has paid nothing, so the plan opens
      // at zero credited. "has recorded ₦0 already paid" reads as a bug.
      await announce({
        amountAlreadyPaid: 0,
        remainingBalance: naira(100_000),
      });

      const message = notifications.create.mock.calls[0][0].message;
      expect(message).not.toMatch(/₦0\.00 already paid/);
      expect(message).toMatch(/has set up a Lopay plan/);
      expect(message).toMatch(/₦100,000\.00 is due/);
    });

    it('never fails a committed claim because the notification failed', async () => {
      notifications.create.mockRejectedValueOnce(new Error('FCM down'));

      await expect(announce()).resolves.toBeUndefined();
      // The realtime nudge still went out — the plan is real either way.
      expect(events.emitEnrollmentsChanged).toHaveBeenCalled();
    });
  });

  // ========================= amendMigratedPayment ==========================

  describe('amendMigratedPayment', () => {
    const enrollment = {
      id: 'enrollment-1',
      totalSchoolFee: naira(100_000),
      remainingBalance: naira(60_000),
      paymentStatus: PaymentStatus.ACTIVE,
      enrollmentInviteId: 'invite-1',
      className: 'Basic 1',
      school: { name: 'Acme Academy' },
      child: { fullName: 'Ada Lovelace', parent: { userId: 'parent-1' } },
      payments: [{ id: 'payment-1', amountPaid: naira(40_000) }],
    };

    beforeEach(() => {
      (prisma.withTenant as jest.Mock).mockReturnValue({
        childEnrollment: { findFirst: jest.fn().mockResolvedValue(enrollment) },
      });
      tx.$queryRaw.mockResolvedValue([
        {
          remainingBalance: naira(60_000),
          totalSchoolFee: naira(100_000),
          paymentStatus: PaymentStatus.ACTIVE,
        },
      ]);
      tx.childEnrollment.update.mockResolvedValue({
        id: 'enrollment-1',
        remainingBalance: naira(65_000),
        paymentStatus: PaymentStatus.ACTIVE,
      });
    });

    /**
     * A correction restates a past figure. It does not assert that the family
     * has caught up, and it must not quietly say so.
     *
     * A migrated plan runs exactly the cadence's span, so passing `termEndDate`
     * with a balance outstanding is the ordinary end of an unpaid plan, not an
     * edge case — `DefaulterDetectionService` flips it to DEFAULTED. Re-deriving
     * ACTIVE from a non-zero balance cleared that: the school's "Defaulted
     * Amount" tile, the admin's defaulted count and the arrears escalation all
     * stopped seeing the family until the next sweep put them back.
     */
    it('leaves a DEFAULTED plan defaulted when a balance remains', async () => {
      tx.$queryRaw.mockResolvedValue([
        {
          remainingBalance: naira(60_000),
          totalSchoolFee: naira(100_000),
          paymentStatus: PaymentStatus.DEFAULTED,
        },
      ]);

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );

      expect(tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            remainingBalance: naira(65_000),
            paymentStatus: PaymentStatus.DEFAULTED,
          }),
        }),
      );
    });

    it('still completes a DEFAULTED plan when the correction clears it', async () => {
      // Settling is the one transition the new balance does determine: a family
      // that owes nothing is not in default, whatever the sweep last recorded.
      tx.$queryRaw.mockResolvedValue([
        {
          remainingBalance: naira(60_000),
          totalSchoolFee: naira(100_000),
          paymentStatus: PaymentStatus.DEFAULTED,
        },
      ]);
      tx.childEnrollment.update.mockResolvedValue({
        id: 'enrollment-1',
        remainingBalance: 0,
        paymentStatus: PaymentStatus.COMPLETED,
      });

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(100_000),
        'school-1',
        ACTOR,
      );

      expect(tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            remainingBalance: 0,
            paymentStatus: PaymentStatus.COMPLETED,
          }),
        }),
      );
    });

    /**
     * The status the audit row reports as `before` must be the one the write
     * actually displaced. It was read from the pre-transaction snapshot, which
     * is older than the locked row and can disagree with it — an audit trail
     * whose `before` never held is worse than none.
     */
    it('audits the status it displaced, not the one it read before locking', async () => {
      tx.$queryRaw.mockResolvedValue([
        {
          remainingBalance: naira(60_000),
          totalSchoolFee: naira(100_000),
          // The sweep defaulted the plan between the two reads. `enrollment`
          // (the fixture above) still says ACTIVE.
          paymentStatus: PaymentStatus.DEFAULTED,
        },
      ]);

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );

      const [entry] = audit.record.mock.calls.at(-1)!;
      expect(entry.before.enrollmentStatus).toBe(PaymentStatus.DEFAULTED);
    });

    it('re-derives the balance from the corrected figure', async () => {
      // ₦40,000 corrected down to ₦35,000, nothing paid in instalments since →
      // ₦100,000 − ₦35,000 = ₦65,000 outstanding.
      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );

      expect(tx.childEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            firstPaymentPaid: naira(35_000),
            remainingBalance: naira(65_000),
            paymentStatus: PaymentStatus.ACTIVE,
          }),
        }),
      );
    });

    it('writes a balance and a status that agree, even after an overpayment clamp', async () => {
      // The invariant `remaining = fee − migrated − instalments` does not hold
      // universally: `confirmPayment` clamps an overpaid balance to zero. An
      // earlier version set the balance by `increment: old − new` while taking
      // the status from the recomputed total, so on a clamped plan the row
      // could commit COMPLETED with a non-zero balance, or ACTIVE at zero.
      //
      // Here the plan is clamped at 0 with ₦70,000 of instalments against a
      // ₦100,000 fee and ₦40,000 migrated (₦10,000 overpaid). Correcting the
      // migrated figure down to ₦30,000 lands exactly on zero.
      tx.$queryRaw.mockResolvedValue([
        {
          remainingBalance: 0,
          totalSchoolFee: naira(100_000),
          paymentStatus: PaymentStatus.COMPLETED,
        },
      ]);
      tx.payment.aggregate.mockResolvedValue({
        _sum: { amountPaid: naira(70_000) },
      });
      tx.childEnrollment.update.mockResolvedValue({
        id: 'enrollment-1',
        remainingBalance: 0,
        paymentStatus: PaymentStatus.COMPLETED,
      });

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(30_000),
        'school-1',
        ACTOR,
      );

      const written = tx.childEnrollment.update.mock.calls[0][0].data;
      expect(written.remainingBalance).toBe(0);
      expect(written.paymentStatus).toBe(PaymentStatus.COMPLETED);
    });

    it('restates the invite too, so the school stops seeing the old figure', async () => {
      // The invite row is what the owner's list renders and what the amend form
      // pre-fills as "Currently recorded". Leaving it behind made a successful
      // correction look like it had not applied.
      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );

      expect(tx.enrollmentInvite.updateMany).toHaveBeenCalledWith({
        where: { id: 'invite-1' },
        data: { amountAlreadyPaid: naira(35_000) },
      });
    });

    it('leaves the invite alone for a plan that did not come from one', async () => {
      (prisma.withTenant as jest.Mock).mockReturnValue({
        childEnrollment: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...enrollment, enrollmentInviteId: null }),
        },
      });

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );

      expect(tx.enrollmentInvite.updateMany).not.toHaveBeenCalled();
    });

    it('notifies the parent only AFTER the transaction commits', async () => {
      const order: string[] = [];
      tx.childEnrollment.update.mockImplementation(() => {
        order.push('write');
        return Promise.resolve({
          id: 'enrollment-1',
          remainingBalance: naira(65_000),
          paymentStatus: PaymentStatus.ACTIVE,
        });
      });
      notifications.create.mockImplementation(() => {
        order.push('notify');
        return Promise.resolve({});
      });

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );

      // A notification is a row on the non-transactional client plus a socket
      // emit plus an awaited FCM push. None of it can be undone by a rollback.
      expect(order).toEqual(['write', 'notify']);
    });

    it('never fails a committed correction because the notification failed', async () => {
      notifications.create.mockRejectedValueOnce(new Error('FCM down'));

      await expect(
        ledger.amendMigratedPayment(
          'enrollment-1',
          naira(35_000),
          'school-1',
          ACTOR,
        ),
      ).resolves.toMatchObject({ amountAlreadyPaid: 35_000 });
    });

    it('locks the enrollment row before reading the balance', async () => {
      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );
      expect(tx.$queryRaw).toHaveBeenCalled();
    });

    it('guards the payment update on the amount it read', async () => {
      // Two concurrent corrections must not both apply their own delta.
      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );
      expect(tx.payment.updateMany.mock.calls[0][0].where).toMatchObject({
        id: 'payment-1',
        amountPaid: naira(40_000),
      });
    });

    it('aborts when another correction won the race', async () => {
      tx.payment.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        ledger.amendMigratedPayment(
          'enrollment-1',
          naira(35_000),
          'school-1',
          ACTOR,
        ),
      ).rejects.toThrow(/changed by someone else/);
    });

    it('completes the plan when the correction clears the balance', async () => {
      tx.childEnrollment.update.mockResolvedValue({
        id: 'enrollment-1',
        remainingBalance: 0,
        paymentStatus: PaymentStatus.COMPLETED,
      });

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(100_000),
        'school-1',
        ACTOR,
      );

      expect(
        tx.childEnrollment.update.mock.calls[0][0].data.paymentStatus,
      ).toBe(PaymentStatus.COMPLETED);
    });

    it('refuses a correction that would leave the plan overpaid, and quantifies it', async () => {
      // ₦30,000 of installments already paid; correcting the migrated figure up
      // to ₦90,000 would exceed the ₦100,000 fee by ₦20,000.
      tx.payment.aggregate.mockResolvedValue({
        _sum: { amountPaid: naira(30_000) },
      });

      await expect(
        ledger.amendMigratedPayment(
          'enrollment-1',
          naira(90_000),
          'school-1',
          ACTOR,
        ),
      ).rejects.toThrow(/overpaid by ₦20,000\.00/);
    });

    it('accounts for confirmed installments when re-deriving the balance', async () => {
      tx.payment.aggregate.mockResolvedValue({
        _sum: { amountPaid: naira(20_000) },
      });

      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(50_000),
        'school-1',
        ACTOR,
      );

      // 100,000 − 50,000 − 20,000 = 30,000 owing, so the plan stays ACTIVE.
      expect(
        tx.childEnrollment.update.mock.calls[0][0].data.paymentStatus,
      ).toBe(PaymentStatus.ACTIVE);
    });

    it.each([
      ['a negative amount', -1],
      ['a fractional kobo amount', 100.5],
    ])('rejects %s before touching the database', async (_label, amount) => {
      await expect(
        ledger.amendMigratedPayment('enrollment-1', amount, 'school-1', ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.withTenant).not.toHaveBeenCalled();
    });

    it('rejects an amount above the school fee', async () => {
      await expect(
        ledger.amendMigratedPayment(
          'enrollment-1',
          naira(150_000),
          'school-1',
          ACTOR,
        ),
      ).rejects.toThrow(/cannot exceed the school fee/);
    });

    it('rejects a no-op correction', async () => {
      await expect(
        ledger.amendMigratedPayment(
          'enrollment-1',
          naira(40_000),
          'school-1',
          ACTOR,
        ),
      ).rejects.toThrow(/same as the recorded one/);
    });

    it('refuses a plan that never came from an invite', async () => {
      (prisma.withTenant as jest.Mock).mockReturnValue({
        childEnrollment: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...enrollment, payments: [] }),
        },
      });

      await expect(
        ledger.amendMigratedPayment(
          'enrollment-1',
          naira(1),
          'school-1',
          ACTOR,
        ),
      ).rejects.toThrow(/did not start from an enrollment invite/);
    });

    it('scopes the lookup to the school, so one school cannot amend another’s plan', async () => {
      (prisma.withTenant as jest.Mock).mockReturnValue({
        childEnrollment: { findFirst: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        ledger.amendMigratedPayment(
          'enrollment-1',
          naira(1),
          'other-school',
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.withTenant).toHaveBeenCalledWith('other-school');
    });

    it('audits the restatement with both figures', async () => {
      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
        'bank statement',
      );

      const [entry, client] = audit.record.mock.calls[0];
      expect(entry).toMatchObject({
        action: AuditAction.MIGRATED_PAYMENT_AMENDED,
        reason: 'bank statement',
        before: expect.objectContaining({ amountPaid: naira(40_000) }),
        after: expect.objectContaining({ amountPaid: naira(35_000) }),
      });
      expect(client).toBe(tx);
    });

    it('tells the parent what changed and what they now owe', async () => {
      await ledger.amendMigratedPayment(
        'enrollment-1',
        naira(35_000),
        'school-1',
        ACTOR,
      );

      const message = notifications.create.mock.calls[0][0].message as string;
      expect(message).toContain('₦40,000.00');
      expect(message).toContain('₦35,000.00');
      expect(message).toContain('₦65,000.00');
      // A correction that costs the parent money tells them how to contest it.
      expect(message).toMatch(/contact the school/);
    });
  });

  // ====================== releaseMigratedEnrollment ========================

  /**
   * Undoing a plan the wrong person claimed.
   *
   * The only method here that DELETES. That is deliberate and narrow: `amend`
   * restates a wrong figure on the right family's plan, while this is for a plan
   * that should never have existed, where there is no figure to restate and
   * every row is a record of something that did not happen.
   */
  describe('releaseMigratedEnrollment', () => {
    const migratedOnly = {
      id: 'enrollment-1',
      className: 'Basic 1',
      totalSchoolFee: naira(100_000),
      firstPaymentPaid: naira(40_000),
      remainingBalance: naira(60_000),
      paymentStatus: PaymentStatus.ACTIVE,
      termStartDate: new Date('2026-09-19T00:00:00.000Z'),
      termEndDate: new Date('2026-12-19T00:00:00.000Z'),
      payments: [
        {
          id: 'payment-1',
          amountPaid: naira(40_000),
          paymentType: PaymentType.MIGRATED_PAYMENT,
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          paymentDate: new Date('2026-09-19T00:00:00.000Z'),
        },
      ],
    };

    const run = (reason?: string) =>
      ledger.releaseMigratedEnrollment(tx as never, {
        enrollmentId: 'enrollment-1',
        childId: 'child-1',
        inviteId: 'invite-1',
        schoolId: 'school-1',
        actor: ACTOR,
        reason,
      });

    beforeEach(() => {
      tx.childEnrollment.findUnique.mockResolvedValue(migratedOnly);
    });

    it('removes the payment, the plan and the fabricated child', async () => {
      // The Child row goes because the claim INVENTED it — created under the
      // claimant's Parent row from a name the school typed. Leaving it would
      // attach a stranger's account to a real student's name permanently.
      await run();

      expect(tx.payment.deleteMany).toHaveBeenCalledWith({
        where: { enrollmentId: 'enrollment-1' },
      });
      expect(tx.childEnrollment.delete).toHaveBeenCalledWith({
        where: { id: 'enrollment-1' },
      });
      expect(tx.child.delete).toHaveBeenCalledWith({
        where: { id: 'child-1' },
      });
    });

    it('deletes in foreign-key order', async () => {
      await run();

      const order = [
        tx.payment.deleteMany.mock.invocationCallOrder[0],
        tx.childEnrollment.delete.mock.invocationCallOrder[0],
        tx.child.delete.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    /**
     * The audit row is the ONLY surviving record, so it has to be complete and
     * it has to be snapshotted before the deletes.
     */
    it('preserves the whole before-state on the audit row', async () => {
      await run('wrong parent claimed it');

      const [entry] = audit.record.mock.calls.at(-1)!;
      expect(entry.action).toBe(AuditAction.ENROLLMENT_INVITE_RELEASED);
      expect(entry.entityId).toBe('invite-1');
      expect(entry.reason).toBe('wrong parent claimed it');
      expect(entry.before).toMatchObject({
        enrollmentId: 'enrollment-1',
        childId: 'child-1',
        totalSchoolFee: naira(100_000),
        firstPaymentPaid: naira(40_000),
        remainingBalance: naira(60_000),
      });
      // Including the money rows themselves — nothing else will remember them.
      expect(entry.before.payments).toHaveLength(1);
      expect(entry.before.payments[0]).toMatchObject({
        id: 'payment-1',
        amountPaid: naira(40_000),
      });
      expect(entry.after).toBeNull();
    });

    it('audits inside the caller’s transaction, not outside it', async () => {
      await run();

      const [, client] = audit.record.mock.calls.at(-1)!;
      expect(client).toBe(tx);
    });

    /**
     * The one refusal. Real money has moved, and deleting the plan destroys the
     * only record of where it went — leaving whoever paid with nothing.
     */
    it('REFUSES when confirmed instalments have been paid against the plan', async () => {
      tx.childEnrollment.findUnique.mockResolvedValue({
        ...migratedOnly,
        payments: [
          ...migratedOnly.payments,
          {
            id: 'payment-2',
            amountPaid: naira(20_000),
            paymentType: PaymentType.INSTALLMENT,
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
            paymentDate: new Date(),
          },
        ],
      });

      await expect(run()).rejects.toBeInstanceOf(BadRequestException);
      await expect(run()).rejects.toThrow(/₦20,000/);
      expect(tx.payment.deleteMany).not.toHaveBeenCalled();
      expect(tx.childEnrollment.delete).not.toHaveBeenCalled();
      expect(tx.child.delete).not.toHaveBeenCalled();
    });

    it('ignores an UNCONFIRMED instalment, which is not money that arrived', async () => {
      // A submitted-but-unapproved transfer has not been accepted by anyone. It
      // must not permanently block the school from undoing a wrong claim.
      tx.childEnrollment.findUnique.mockResolvedValue({
        ...migratedOnly,
        payments: [
          ...migratedOnly.payments,
          {
            id: 'payment-2',
            amountPaid: naira(20_000),
            paymentType: PaymentType.INSTALLMENT,
            status: PaymentTransactionStatus.PENDING,
            isConfirmed: false,
            paymentDate: new Date(),
          },
        ],
      });

      await expect(run()).resolves.toMatchObject({ removedPayments: 1 });
    });

    it('refuses a plan that is already gone', async () => {
      tx.childEnrollment.findUnique.mockResolvedValue(null);

      await expect(run()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('emits nothing — the caller announces after commit', async () => {
      await run();

      expect(events.emitEnrollmentsChanged).not.toHaveBeenCalled();
      expect(events.emitPaymentsChanged).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});

/** A Prisma P2002 that passes the service's `instanceof` check. */
function prismaConflict(target: string[]): Error {
  const error = Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  });
  Object.setPrototypeOf(
    error,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../generated/prisma/client').Prisma.PrismaClientKnownRequestError
      .prototype,
  );
  return error;
}
