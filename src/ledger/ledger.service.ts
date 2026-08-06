import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentType,
  PaymentReceiver,
  AuditAction,
  NotificationType,
  UserRole,
  Prisma,
} from '../generated/prisma/client';
import { EventsGateway } from '../events/events.gateway';
import { AuditService, AuditActor } from '../audit/audit.service';
import { Money } from '../common/money';
import { errorMessage } from '../common/errors';
import { MetricsService } from '../common/observability/metrics.service';
import { captureMessage } from '../common/observability/sentry';

/**
 * The single owner of every money-state transition (Milestone 3).
 *
 * Each method follows the same invariant-preserving shape:
 *   pre-fetch (fast not-found / relations)
 *   -> $transaction { guarded conditional updateMany (count===0 aborts, so the
 *      transition is exactly-once under concurrency) -> atomic balance inc/dec
 *      with clamp -> audit.record(tx) -> notify } -> emit realtime events.
 *
 * Feature services (schools / admin / enrollment) are thin callers that delegate
 * here, so balance math and audit semantics live in exactly one place. Behavior
 * is locked by the characterization suites in ledger.service.spec.ts.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Seconds from a payment's submission timestamp to now (for confirm latency).
   * Returns undefined for a missing/invalid date so a metrics detail can never
   * throw inside a money path.
   */
  private static latencySeconds(
    submittedAt: Date | null | undefined,
  ): number | undefined {
    if (!(submittedAt instanceof Date) || Number.isNaN(submittedAt.getTime())) {
      return undefined;
    }
    return Math.max(0, (Date.now() - submittedAt.getTime()) / 1000);
  }

  /**
   * Credit a confirmed first payment's school share against the enrollment and
   * move the plan to its resulting state.
   *
   * An enrollment opens with the WHOLE school fee outstanding — the deposit is
   * only credited here, by whichever path confirms the money (Paystack reconcile,
   * admin settle, or a school owner's manual confirm). Previously the balance was
   * pre-credited at initiation, so an abandoned checkout advertised a payment that
   * never arrived: the parent saw 75% owed having paid nothing, and the platform's
   * arrears book was short the uncollected deposit.
   *
   * Callers must already hold the exactly-once guard (the conditional `updateMany`
   * that flips the payment), so this decrement can never be applied twice. The
   * clamp keeps a slight overpayment from driving the balance negative.
   */
  private async creditFirstPaymentToBalance(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
    schoolAmountKobo: number,
  ): Promise<{ remainingBalance: number; isCompleted: boolean }> {
    const decremented = await tx.childEnrollment.update({
      where: { id: enrollmentId },
      data: { remainingBalance: { decrement: schoolAmountKobo } },
    });

    const isCompleted = decremented.remainingBalance <= 0;
    const remainingBalance = Math.max(0, decremented.remainingBalance);

    await tx.childEnrollment.update({
      where: { id: enrollmentId },
      data: {
        remainingBalance,
        paymentStatus: isCompleted
          ? PaymentStatus.COMPLETED
          : PaymentStatus.ACTIVE,
      },
    });

    return { remainingBalance, isCompleted };
  }

  // ============================== installments ==============================

  async confirmPayment(paymentId: string, schoolId: string, actor: AuditActor) {
    // Pre-fetch (tenant-scoped) for relations + a fast not-found path. The
    // authoritative guard is the conditional updateMany inside the transaction.
    const payment = await this.prisma.withTenant(schoolId).payment.findFirst({
      where: {
        id: paymentId,
        isConfirmed: false,
        paymentType: PaymentType.INSTALLMENT, // first payments settle via their own flow
      },
      include: {
        enrollment: {
          include: { school: true, child: { include: { parent: true } } },
        },
      },
    });

    if (!payment) {
      throw new BadRequestException('Payment not found or already confirmed');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Confirm the payment with a guarded conditional write. If a concurrent
      // request already confirmed it, count === 0 and we abort — no double-credit.
      const confirmed = await tx.payment.updateMany({
        where: {
          id: paymentId,
          schoolId,
          isConfirmed: false,
          paymentType: PaymentType.INSTALLMENT,
        },
        data: {
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
          paymentDate: new Date(),
        },
      });
      if (confirmed.count === 0) {
        throw new BadRequestException('Payment not found or already confirmed');
      }

      // 2. Apply the balance change with an ATOMIC decrement (no read-modify-write),
      // so concurrent confirmations can't lose an update. Read the pre-state only
      // for the audit "before" value — the decrement itself is race-safe.
      const before = await tx.childEnrollment.findUniqueOrThrow({
        where: { id: payment.enrollmentId },
      });
      const decremented = await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: { remainingBalance: { decrement: payment.amountPaid } },
      });

      const isCompleted = decremented.remainingBalance <= 0;
      const newBalance = Math.max(0, decremented.remainingBalance);
      if (isCompleted) {
        // Clamp the (possibly negative) balance to 0 and mark completed.
        await tx.childEnrollment.update({
          where: { id: payment.enrollmentId },
          data: {
            remainingBalance: 0,
            paymentStatus: PaymentStatus.COMPLETED,
          },
        });
      }

      const updatedPayment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      // 2b. Audit (atomic with the confirmation)
      await this.audit.record(
        {
          action: AuditAction.PAYMENT_CONFIRMED,
          entityType: 'Payment',
          entityId: paymentId,
          actor,
          schoolId,
          before: {
            status: payment.status,
            isConfirmed: payment.isConfirmed,
            remainingBalance: before.remainingBalance,
          },
          after: {
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
            remainingBalance: newBalance,
            enrollmentStatus: isCompleted
              ? PaymentStatus.COMPLETED
              : before.paymentStatus,
          },
          metadata: {
            amount: payment.amountPaid,
            isCompleted,
            // True when the approver is also the payer (a school owner confirming
            // a payment on their own child's enrollment at their own school — the
            // only way one person can still hold both halves of this control).
            // Recorded so the maker-checker exception is visible in the audit log.
            selfApproved:
              payment.enrollment.child.parent.userId === actor.userId,
          },
        },
        tx,
      );

      // 3. Notify Parent
      const confirmedAmountStr = Money.fromKobo(
        payment.amountPaid,
      ).formatNaira();
      let message = `Your payment of ${confirmedAmountStr} for ${payment.enrollment.child.fullName} (${payment.enrollment.className}) at ${payment.enrollment.school.name} has been confirmed.`;
      if (isCompleted) {
        message += ' All payments for this semester are now completed.';
      }

      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: isCompleted ? 'Payment Completed' : 'Payment Confirmed',
        message: message,
        link: '/history',
      });

      return {
        ...updatedPayment,
        amount: Money.fromKobo(updatedPayment.amountPaid).toNaira(),
        date: updatedPayment.paymentDate,
        type: updatedPayment.paymentType,
        studentName: payment.enrollment.child.fullName,
        childName: payment.enrollment.child.fullName,
        className: payment.enrollment.className,
        schoolName: payment.enrollment.school.name,
      };
    });

    // Push the change so the parent, school dashboard, and admins refresh
    // their payment/balance views without waiting for a poll.
    this.events.emitPaymentsChanged({
      parentUserId: payment.enrollment.child.parent.userId,
      schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('confirmed', {
      type: PaymentType.INSTALLMENT,
      receiver: payment.receiver,
      latencySeconds: LedgerService.latencySeconds(payment.paymentDate),
    });

    return result;
  }

  async rejectPayment(paymentId: string, schoolId: string, actor: AuditActor) {
    const payment = await this.prisma.withTenant(schoolId).payment.findFirst({
      where: { id: paymentId, isConfirmed: false },
      include: {
        enrollment: {
          include: { school: true, child: { include: { parent: true } } },
        },
      },
    });

    if (!payment) {
      throw new BadRequestException('Payment not found or already processed');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Update Payment Status with a guarded conditional write (idempotent
      // under concurrent reject/confirm — only an unprocessed payment flips).
      const rejected = await tx.payment.updateMany({
        where: { id: paymentId, schoolId, isConfirmed: false },
        data: {
          status: PaymentTransactionStatus.FAILED,
          // isConfirmed stays false
        },
      });
      if (rejected.count === 0) {
        throw new BadRequestException('Payment not found or already processed');
      }
      const updatedPayment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      // 2. If First Payment, Fail Enrollment
      const failedEnrollment =
        payment.paymentType === PaymentType.FIRST_PAYMENT;
      if (failedEnrollment) {
        await tx.childEnrollment.update({
          where: { id: payment.enrollmentId },
          data: {
            paymentStatus: PaymentStatus.FAILED,
          },
        });
      }

      // 2b. Audit (atomic with the rejection)
      await this.audit.record(
        {
          action: AuditAction.PAYMENT_REJECTED,
          entityType: 'Payment',
          entityId: paymentId,
          actor,
          schoolId,
          before: { status: payment.status, isConfirmed: payment.isConfirmed },
          after: {
            status: PaymentTransactionStatus.FAILED,
            isConfirmed: false,
            enrollmentFailed: failedEnrollment,
          },
          metadata: {
            amount: payment.amountPaid,
            paymentType: payment.paymentType,
          },
        },
        tx,
      );

      // 3. Notify Parent
      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: 'Payment Rejected',
        message: `Your payment of ${Money.fromKobo(payment.amountPaid).formatNaira()} for ${payment.enrollment.child.fullName} at ${payment.enrollment.school.name} has been rejected. Please contact the school.`,
        type: NotificationType.ALERT,
        link: '/history',
      });

      return {
        ...updatedPayment,
        amount: Money.fromKobo(updatedPayment.amountPaid).toNaira(),
        date: updatedPayment.paymentDate,
        type: updatedPayment.paymentType,
        studentName: payment.enrollment.child.fullName,
        childName: payment.enrollment.child.fullName,
        className: payment.enrollment.className,
        schoolName: payment.enrollment.school.name,
      };
    });

    this.events.emitPaymentsChanged({
      parentUserId: payment.enrollment.child.parent.userId,
      schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('rejected', {
      type: payment.paymentType,
      receiver: payment.receiver,
    });

    return result;
  }

  /**
   * Reverse a previously-confirmed installment payment (auditable undo).
   * Restores the enrollment balance, marks the payment REVERSED, and records
   * the reason in the audit log. First-payment reversals are intentionally not
   * supported here — they change the enrollment lifecycle and need their own
   * flow.
   */
  async reversePayment(
    paymentId: string,
    schoolId: string,
    actor: AuditActor,
    reason?: string,
  ) {
    const payment = await this.prisma.withTenant(schoolId).payment.findFirst({
      where: {
        id: paymentId,
        isConfirmed: true,
        status: PaymentTransactionStatus.SUCCESS,
        paymentType: PaymentType.INSTALLMENT,
      },
      include: {
        enrollment: {
          include: { school: true, child: { include: { parent: true } } },
        },
      },
    });

    if (!payment) {
      throw new BadRequestException(
        'No confirmed installment payment found to reverse',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Mark payment as reversed with a guarded conditional write. Only a
      // currently-confirmed SUCCESS installment flips — a concurrent double-tap
      // (or replay) finds count === 0 and aborts, so the balance is restored
      // exactly once (no 2× inflation / phantom debt).
      const reversed = await tx.payment.updateMany({
        where: {
          id: paymentId,
          schoolId,
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
          paymentType: PaymentType.INSTALLMENT,
        },
        data: {
          status: PaymentTransactionStatus.REVERSED,
          isConfirmed: false,
        },
      });
      if (reversed.count === 0) {
        throw new BadRequestException(
          'No confirmed installment payment found to reverse',
        );
      }

      // 2. Restore the enrollment balance with an ATOMIC increment, clamped so a
      // restored balance can never exceed the original total school fee.
      const before = await tx.childEnrollment.findUniqueOrThrow({
        where: { id: payment.enrollmentId },
      });
      const reopened = before.paymentStatus === PaymentStatus.COMPLETED;
      const incremented = await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: {
          remainingBalance: { increment: payment.amountPaid },
          paymentStatus: reopened ? PaymentStatus.ACTIVE : before.paymentStatus,
        },
      });
      let restoredBalance = incremented.remainingBalance;
      if (restoredBalance > before.totalSchoolFee) {
        restoredBalance = before.totalSchoolFee;
        await tx.childEnrollment.update({
          where: { id: payment.enrollmentId },
          data: { remainingBalance: restoredBalance },
        });
      }

      const updatedPayment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      // 3. Audit (atomic with the reversal)
      await this.audit.record(
        {
          action: AuditAction.PAYMENT_REVERSED,
          entityType: 'Payment',
          entityId: paymentId,
          actor,
          schoolId,
          reason,
          before: {
            status: payment.status,
            isConfirmed: true,
            remainingBalance: before.remainingBalance,
            enrollmentStatus: before.paymentStatus,
          },
          after: {
            status: PaymentTransactionStatus.REVERSED,
            isConfirmed: false,
            remainingBalance: restoredBalance,
            enrollmentStatus: reopened
              ? PaymentStatus.ACTIVE
              : before.paymentStatus,
          },
          metadata: { amount: payment.amountPaid, reopened },
        },
        tx,
      );

      /*
       * 4. Notify Parent.
       *
       * Worded as "confirmation withdrawn", not "payment reversed". An
       * installment is a bank transfer straight to the school (receiver:
       * SCHOOL, platformAmount: 0) — the platform never holds the money, so a
       * reversal refunds nothing. What the school undid is its own confirmation
       * of the receipt. The old wording told a parent who had transferred real
       * money that their payment "has been reversed", which reads as the school
       * sending it back and sends them chasing a refund that does not exist.
       */
      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: 'Payment Confirmation Withdrawn',
        message: `${payment.enrollment.school.name} has withdrawn its confirmation of a ${Money.fromKobo(payment.amountPaid).formatNaira()} payment for ${payment.enrollment.child.fullName} (${payment.enrollment.className}), so that amount is showing as owed again.${reason ? ` Reason: ${reason}` : ''} No money has been refunded — please contact the school.`,
        type: NotificationType.ALERT,
        link: '/history',
      });

      return {
        ...updatedPayment,
        amount: Money.fromKobo(updatedPayment.amountPaid).toNaira(),
        date: updatedPayment.paymentDate,
        type: updatedPayment.paymentType,
        studentName: payment.enrollment.child.fullName,
        childName: payment.enrollment.child.fullName,
        className: payment.enrollment.className,
        schoolName: payment.enrollment.school.name,
      };
    });

    this.events.emitPaymentsChanged({
      parentUserId: payment.enrollment.child.parent.userId,
      schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('reversed', {
      type: PaymentType.INSTALLMENT,
      receiver: payment.receiver,
    });

    return result;
  }

  // ============================ first payments ============================

  /**
   * Settle school share and activate enrollment.
   *
   * MANUAL first payments only (`paystackReference: null`). A Paystack-collected
   * first payment is created PENDING at *initiation* — before the parent has paid
   * anything — so it would otherwise match this query and let an admin activate an
   * enrollment for money that was never collected. Worse, the manual flip makes the
   * later real `charge.success` a no-op (see `reconcilePaystackPayment`), losing the
   * fee reconciliation and audit trail for an actual charge. Card first payments
   * settle themselves from the webhook / verify-on-return / reconciliation sweep.
   */
  async settleFirstPayment(paymentId: string, actor: AuditActor) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
        paystackReference: null,
      },
      include: {
        enrollment: {
          include: {
            school: true,
            child: {
              include: { parent: true },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found or already settled');
    }

    const { enrollment } = payment;

    const settled = await this.prisma.$transaction(async (tx) => {
      // 1️⃣ Mark payment as confirmed (guarded — only an unconfirmed payment
      // flips, so a concurrent settle/reject/confirm can't double-process).
      const res = await tx.payment.updateMany({
        where: { id: payment.id, isConfirmed: false },
        data: { isConfirmed: true, status: PaymentTransactionStatus.SUCCESS },
      });
      if (res.count === 0) return false;

      // 2️⃣ Credit the school share and activate (or settle) the enrollment.
      const { remainingBalance, isCompleted } =
        await this.creditFirstPaymentToBalance(
          tx,
          payment.enrollmentId,
          payment.schoolAmount,
        );

      // 2b. Audit (atomic with the settlement)
      await this.audit.record(
        {
          action: AuditAction.FIRST_PAYMENT_SETTLED,
          entityType: 'Payment',
          entityId: payment.id,
          actor,
          schoolId: enrollment.schoolId,
          before: {
            isConfirmed: false,
            paymentStatus: enrollment.paymentStatus,
            remainingBalance: enrollment.remainingBalance,
          },
          after: {
            isConfirmed: true,
            paymentStatus: isCompleted
              ? PaymentStatus.COMPLETED
              : PaymentStatus.ACTIVE,
            remainingBalance,
          },
          metadata: { enrollmentId: enrollment.id, amount: payment.amountPaid },
        },
        tx,
      );

      // 3️⃣ Notify School Owner
      await tx.notification.create({
        data: {
          userId: enrollment.school.ownerId,
          title: 'First Payment Settled',
          message:
            'The platform has settled the first payment. Enrollment is now active.',
          link: '/school-owner-dashboard',
        },
      });

      // 4️⃣ Notify Parent
      // `/dashboard` — the plan card there carries the now-active status. There is
      // no `/parent/enrollments/:id` route in the app; linking to one dead-ended
      // the tap.
      return tx.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'Enrollment Confirmed',
          message: `Your first payment of ${Money.fromKobo(payment.amountPaid).formatNaira()} has been confirmed. Enrollment is active.`,
          link: '/dashboard',
        },
      });
    });

    if (!settled) {
      throw new NotFoundException('Payment not found or already settled');
    }

    // In-transaction notification, so push it here. This is an admin-initiated
    // settle: nothing else in the request touches the parent's client, and their
    // enrollment just went active.
    this.events.pushNotification(enrollment.child.parent.userId, settled);
    this.events.emitEnrollmentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('confirmed', {
      type: PaymentType.FIRST_PAYMENT,
      receiver: payment.receiver,
      latencySeconds: LedgerService.latencySeconds(payment.paymentDate),
    });

    return {
      message: 'Payment settled and enrollment activated successfully',
      paymentId: payment.id,
    };
  }

  /**
   * Reject a pending first payment and mark enrollment as failed.
   *
   * MANUAL first payments only (`paystackReference: null`) — same reasoning as
   * `settleFirstPayment`, but the failure mode is worse in this direction: a
   * rejected-then-completed card payment leaves the charge captured and split at
   * Paystack while our enrollment sits FAILED, and the arriving `charge.success`
   * can no longer flip a non-PENDING row. Card failures come from Paystack itself
   * (`charge.failed`, or the 24h abandonment sweep).
   */
  async rejectFirstPayment(paymentId: string, actor: AuditActor) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
        paystackReference: null,
      },
      include: {
        enrollment: {
          include: {
            school: true,
            child: {
              include: { parent: true },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException(
        'First payment not found or already processed',
      );
    }

    const { enrollment } = payment;

    const rejectedOk = await this.prisma.$transaction(async (tx) => {
      // 1️⃣ Mark payment as failed (guarded — only an unprocessed payment flips).
      const res = await tx.payment.updateMany({
        where: { id: payment.id, isConfirmed: false },
        data: {
          status: PaymentTransactionStatus.FAILED,
        },
      });
      if (res.count === 0) return false;

      // 2️⃣ Mark enrollment as FAILED (no balance changes)
      await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: { paymentStatus: PaymentStatus.FAILED },
      });

      // 2b. Audit (atomic with the rejection)
      await this.audit.record(
        {
          action: AuditAction.FIRST_PAYMENT_REJECTED,
          entityType: 'Payment',
          entityId: payment.id,
          actor,
          schoolId: enrollment.schoolId,
          before: {
            isConfirmed: false,
            paymentStatus: enrollment.paymentStatus,
          },
          after: {
            status: PaymentTransactionStatus.FAILED,
            paymentStatus: PaymentStatus.FAILED,
          },
          metadata: { enrollmentId: enrollment.id, amount: payment.amountPaid },
        },
        tx,
      );

      // 3️⃣ Notify School Owner (optional visibility)
      await tx.notification.create({
        data: {
          userId: enrollment.school.ownerId,
          title: 'First Payment Rejected',
          message:
            'The platform has rejected the first payment for this enrollment. Please review the receipt or contact the parent.',
          link: '/school-owner-dashboard',
        },
      });

      // 4️⃣ Notify Parent
      // `/dashboard` — the plan card there is where the retry lives. There is no
      // `/parent/enrollments/:id` route in the app.
      return tx.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'First Payment Rejected',
          message:
            'Your first payment could not be verified. Please pay again and upload a clearer receipt.',
          type: NotificationType.ALERT,
          link: '/dashboard',
        },
      });
    });

    if (!rejectedOk) {
      throw new NotFoundException(
        'First payment not found or already processed',
      );
    }

    // In-transaction notification on an admin-initiated reject — push it so the
    // parent learns their enrollment needs a retry without waiting for a poll.
    this.events.pushNotification(enrollment.child.parent.userId, rejectedOk);
    this.events.emitEnrollmentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('rejected', {
      type: PaymentType.FIRST_PAYMENT,
      receiver: payment.receiver,
    });

    return {
      message: 'First payment rejected and enrollment marked as failed',
      paymentId: payment.id,
    };
  }

  // =========================== paystack reconcile ===========================

  /**
   * A `charge.success` arrived for a payment that is no longer PENDING (FAILED or
   * REVERSED in our books). Real money has moved at Paystack and the split has
   * already paid the school subaccount, so this is a book-vs-bank break that only a
   * human can resolve — the parent may have re-enrolled since, and the enrollment's
   * balance may already reflect a different plan.
   *
   * We therefore change NO money state: we record the break loudly (error log +
   * metric + Sentry) and notify every super admin with the reference and amount.
   * Returning `reconciled: false` keeps the webhook's 200 (the event is not
   * retryable — retrying would not fix a conflict) while making the discrepancy
   * impossible to miss.
   *
   * The alert is raised AT MOST ONCE per reference. Three separate callers can reach
   * this (the webhook, the parent-triggered verify-on-return, and the reconciliation
   * sweep), and verify-on-return is a plain GET the parent can repeat by refreshing
   * — without a durable guard, one conflicted payment would fan out an unbounded
   * stream of ALERTs to every admin and bury the signal it exists to raise. The
   * `WebhookEvent` unique `dedupeKey` is reused as that guard: it is the table
   * already dedicating a uniquely-constrained row per provider event, so the marker
   * survives restarts and is shared across instances, and the row doubles as an
   * auditable record of the break.
   */
  private async escalateReconcileConflict(
    payment: {
      id: string;
      status: PaymentTransactionStatus;
      amountPaid: number;
      schoolId: string;
      enrollmentId: string;
    },
    reference: string,
    actualFeeKobo: number | null,
  ): Promise<{ reconciled: false; reason: 'status_conflict'; status: string }> {
    const outcome = {
      reconciled: false as const,
      reason: 'status_conflict' as const,
      status: payment.status,
    };

    const amountStr = Money.fromKobo(payment.amountPaid).formatNaira();
    const detail =
      `Paystack reported a SUCCESSFUL charge for ${reference} (${amountStr}) ` +
      `but the payment is ${payment.status} in our books. The money has been ` +
      `captured and split at Paystack; no state was changed automatically.`;

    // Claim the alert. A duplicate key means another caller already escalated this
    // reference — still log it (the operator needs to see repeat hits) but do not
    // re-notify.
    const dedupeKey = `reconcile.conflict:${reference}`;
    let alreadyEscalated = false;
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: 'paystack',
          eventType: 'reconcile.conflict',
          dedupeKey,
          reference,
          payload: {
            paymentId: payment.id,
            enrollmentId: payment.enrollmentId,
            schoolId: payment.schoolId,
            localStatus: payment.status,
            amountPaid: payment.amountPaid,
            actualPaystackFee: actualFeeKobo,
          },
          error: detail,
        },
      });
    } catch (err) {
      if (!this.isUniqueConflictOn(err, 'dedupeKey')) throw err;
      alreadyEscalated = true;
    }

    this.logger.error(detail);
    if (alreadyEscalated) {
      this.logger.warn(
        `Reconcile conflict on ${reference} already escalated — not re-alerting.`,
      );
      return outcome;
    }

    this.metrics.recordReconcileConflict(payment.status);
    captureMessage(`Paystack reconcile conflict on ${reference}`, 'error', {
      reference,
      paymentId: payment.id,
      enrollmentId: payment.enrollmentId,
      schoolId: payment.schoolId,
      localStatus: payment.status,
      amountPaid: payment.amountPaid,
      actualPaystackFee: actualFeeKobo,
    });

    // Deliver the alert — with the claim above already taken, a delivery failure
    // must not become a PERMANENTLY lost alert. The claim is created first because
    // at-most-once matters under concurrency (three callers race here, and one is
    // a GET the parent can spam), but that ordering means a fan-out that dies after
    // the claim would mark the break "escalated" while no human ever heard about
    // it. So: each admin is notified independently (one bad row cannot sink the
    // batch), and if NOBODY could be told, the claim is released so the next
    // charge.success replay escalates again instead of hitting the dedupe wall.
    let intendedRecipients = 0;
    let delivered = 0;
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN },
        select: { id: true },
      });
      intendedRecipients = admins.length;
      const deliveries = await Promise.allSettled(
        admins.map((admin) =>
          this.notificationsService.create({
            userId: admin.id,
            title: 'Payment needs manual reconciliation',
            // Deliberately does NOT promise an in-app settle button: card first
            // payments are no longer manually settleable (that guard is what stops an
            // uncollected payment being approved), so the resolution is on Paystack's
            // side — refund the parent, or pay the school and have the parent re-enroll.
            message: `${detail} Resolve it on the Paystack dashboard (refund the payer, or settle the school directly) — the app will not activate this enrollment on its own.`,
            type: NotificationType.ALERT,
            link: '/admin/approvals',
          }),
        ),
      );
      for (const delivery of deliveries) {
        if (delivery.status === 'fulfilled') {
          delivered += 1;
        } else {
          this.logger.error(
            `Failed to notify an admin about the reconcile conflict on ${reference}: ${errorMessage(delivery.reason)}`,
          );
        }
      }
    } catch (err) {
      // The admin lookup itself failed — treat it as zero deliveries below.
      this.logger.error(
        `Could not look up admins for the reconcile conflict on ${reference}: ${errorMessage(err)}`,
      );
      intendedRecipients = -1; // unknown, but certainly not "nobody to tell"
    }

    if (intendedRecipients !== 0 && delivered === 0) {
      // Nobody heard the one alert this path exists to raise. Release the claim
      // (best-effort — losing the release only re-arms the dedupe, never money)
      // so a later replay of the charge re-escalates.
      await this.prisma.webhookEvent
        .delete({ where: { dedupeKey } })
        .catch(() => undefined);
      this.logger.error(
        `No admin was notified of the reconcile conflict on ${reference}; ` +
          `released the escalation claim so the next replay re-alerts.`,
      );
    }

    return outcome;
  }

  /** True when an error is the unique-constraint violation on the given field. */
  private isUniqueConflictOn(error: unknown, field: string): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }
    const target = error.meta?.target;
    return Array.isArray(target)
      ? target.includes(field)
      : typeof target === 'string' && target.includes(field);
  }

  async reconcilePaystackPayment(
    reference: string,
    actualFeeKobo: number | null,
    actor: AuditActor | null,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { paystackReference: reference },
      include: {
        enrollment: {
          include: { school: true, child: { include: { parent: true } } },
        },
      },
    });
    if (!payment) {
      this.logger.warn(
        `Paystack reconcile: no payment for reference ${reference}`,
      );
      return { reconciled: false, reason: 'unknown_reference' };
    }
    if (payment.status === PaymentTransactionStatus.SUCCESS) {
      return { reconciled: true, alreadyProcessed: true };
    }
    // Money arrived for a payment our books had already closed the other way
    // (FAILED by charge.failed / the abandonment sweep, or REVERSED by a dispute).
    // The SUCCESS flip below is guarded on PENDING, so it would silently no-op and
    // report success — the one outcome we must never produce: Paystack has captured
    // and split real money while the enrollment stays failed. Hold the state and
    // escalate to a human instead of guessing.
    if (payment.status !== PaymentTransactionStatus.PENDING) {
      return this.escalateReconcileConflict(payment, reference, actualFeeKobo);
    }

    const { enrollment } = payment;

    // Concurrency: the webhook and the verify-on-return endpoint both call this.
    // Guard the SUCCESS flip with a conditional write so only the first one wins;
    // a second concurrent call finds count === 0 and is a clean no-op (no double
    // activation, no duplicate audit row, no duplicate notification).
    const processed = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentTransactionStatus.PENDING },
        data: {
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          // estimate stays in paystackFee; the authoritative fee is recorded below.
          actualPaystackFee: actualFeeKobo ?? null,
          paymentDate: new Date(),
        },
      });
      if (flipped.count === 0) {
        return null; // already reconciled by a concurrent caller
      }

      // The deposit is credited here, not at initiation — see
      // creditFirstPaymentToBalance.
      const credited = await this.creditFirstPaymentToBalance(
        tx,
        enrollment.id,
        payment.schoolAmount,
      );

      // Reconcile the estimated Paystack fee against the actual one Paystack
      // charged the platform account, so the book vs. bank discrepancy is
      // auditable rather than silently absorbed (the platform bears the fee).
      const estimateFee = payment.paystackFee ?? 0;
      const actualFee = actualFeeKobo ?? estimateFee;
      const feeDelta = actualFee - estimateFee;

      await this.audit.record(
        {
          action: AuditAction.FIRST_PAYMENT_PAID,
          entityType: 'Payment',
          entityId: payment.id,
          actor,
          schoolId: payment.schoolId,
          before: {
            status: payment.status,
            isConfirmed: payment.isConfirmed,
            remainingBalance: enrollment.remainingBalance,
          },
          after: {
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
            enrollmentStatus: credited.isCompleted
              ? PaymentStatus.COMPLETED
              : PaymentStatus.ACTIVE,
            remainingBalance: credited.remainingBalance,
          },
          metadata: {
            reference,
            amountCharged: payment.amountCharged,
            platformAmount: payment.platformAmount,
            schoolAmount: payment.schoolAmount,
            estimatedPaystackFee: estimateFee,
            actualPaystackFee: actualFee,
            // Non-zero means the platform main account netted platformFee ± this
            // amount (Paystack bears the fee off that account). Surfaced for
            // reconciliation; investigate sustained drift.
            paystackFeeDelta: feeDelta,
          },
        },
        tx,
      );

      if (feeDelta !== 0) {
        this.logger.warn(
          `Paystack fee delta ${feeDelta} kobo on ${reference} (estimate ${estimateFee}, actual ${actualFee})`,
        );
      }

      return { ...credited, feeDelta };
    });

    if (!processed) {
      return { reconciled: true, alreadyProcessed: true };
    }
    const { isCompleted } = processed;

    // Recorded outside the transaction so a rollback can't leave a phantom drift on
    // the gauge. Sustained positive drift means our fee estimate is systematically
    // low (e.g. an un-modelled VAT or a pricing change) — see common/paystack-fee.ts.
    this.metrics.recordPaystackFeeDelta(processed.feeDelta);

    // Notify parent + school owner (post-transaction).
    await this.notificationsService.create({
      userId: enrollment.child.parent.userId,
      title: isCompleted ? 'Payment Completed' : 'First Payment Confirmed',
      message: `Your payment of ${Money.fromKobo(payment.amountPaid).formatNaira()} for ${enrollment.child.fullName} at ${enrollment.school.name} has been confirmed.${isCompleted ? ' All fees are now fully paid.' : ' Enrollment is now active.'}`,
      link: '/history',
    });
    if (enrollment.school.ownerId) {
      await this.notificationsService.create({
        userId: enrollment.school.ownerId,
        title: 'First Payment Received',
        message: `${Money.fromKobo(payment.schoolAmount).formatNaira()} settled to your account for ${enrollment.child.fullName} (${enrollment.className}).`,
        link: '/school-owner-dashboard',
      });
    }

    this.events.emitEnrollmentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('confirmed', {
      type: PaymentType.FIRST_PAYMENT,
      receiver: payment.receiver,
      latencySeconds: LedgerService.latencySeconds(payment.paymentDate),
    });

    return { reconciled: true, completed: isCompleted };
  }

  /** Mark a Paystack first payment FAILED (charge.failed). Allows retry. */
  async failPaystackPayment(reference: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { paystackReference: reference },
      include: {
        enrollment: { include: { child: { include: { parent: true } } } },
      },
    });
    if (!payment || payment.status !== PaymentTransactionStatus.PENDING) {
      return { updated: false };
    }

    // Guard the FAILED flip: only a still-PENDING payment may fail. A replayed
    // charge.failed (or one racing a charge.success) finds count === 0 and is a
    // no-op, so it can't flip an already-succeeded payment.
    const flipped = await this.prisma.$transaction(async (tx) => {
      const res = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentTransactionStatus.PENDING },
        data: { status: PaymentTransactionStatus.FAILED },
      });
      if (res.count === 0) return false;
      await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
      return true;
    });

    if (!flipped) return { updated: false };

    const parentUserId = payment.enrollment?.child?.parent?.userId;

    if (parentUserId) {
      await this.notificationsService.create({
        userId: parentUserId,
        title: 'Payment Failed',
        message: 'Your first payment did not go through. Please try again.',
        type: NotificationType.ALERT,
        link: '/history',
      });
    }

    // Every other money transition in this file pushes these; failure was the
    // one that did not, and it moved BOTH the payment and the enrollment
    // (PENDING → FAILED). The notification push only invalidates the
    // notifications query, so without these an open dashboard kept rendering the
    // plan as PENDING — the parent read "Payment Failed" in a toast while the
    // card behind it still showed the charge in flight.
    this.events.emitEnrollmentsChanged({
      parentUserId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('failed', {
      type: PaymentType.FIRST_PAYMENT,
      receiver: payment.receiver,
    });

    return { updated: true };
  }

  // ========================= enrollment lifecycle =========================

  async reversePaystackPaymentByDispute(
    reference: string,
    eventType: string,
  ): Promise<{ reversed: boolean }> {
    const payment = await this.prisma.payment.findUnique({
      where: { paystackReference: reference },
      include: {
        enrollment: {
          include: { school: true, child: { include: { parent: true } } },
        },
      },
    });
    if (
      !payment ||
      payment.status === PaymentTransactionStatus.FAILED ||
      payment.status === PaymentTransactionStatus.REVERSED
    ) {
      return { reversed: false };
    }

    const { enrollment } = payment;
    const wasActive = enrollment.paymentStatus === PaymentStatus.ACTIVE;
    const wasCompleted = enrollment.paymentStatus === PaymentStatus.COMPLETED;

    const flipped = await this.prisma.$transaction(async (tx) => {
      const res = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentTransactionStatus.SUCCESS,
        },
        data: { status: PaymentTransactionStatus.FAILED, isConfirmed: false },
      });
      if (res.count === 0) return false;

      if (wasActive || wasCompleted) {
        await tx.childEnrollment.update({
          where: { id: enrollment.id },
          data: {
            paymentStatus: PaymentStatus.FAILED,
            remainingBalance: enrollment.totalSchoolFee,
          },
        });
      } else {
        await tx.childEnrollment.update({
          where: { id: enrollment.id },
          data: { paymentStatus: PaymentStatus.FAILED },
        });
      }

      await this.audit.record(
        {
          action: AuditAction.PAYMENT_DISPUTED,
          entityType: 'Payment',
          entityId: payment.id,
          actor: null,
          schoolId: payment.schoolId,
          before: {
            status: payment.status,
            isConfirmed: payment.isConfirmed,
            enrollmentStatus: enrollment.paymentStatus,
            remainingBalance: enrollment.remainingBalance,
          },
          after: {
            status: PaymentTransactionStatus.FAILED,
            isConfirmed: false,
            enrollmentStatus: PaymentStatus.FAILED,
            remainingBalance:
              wasActive || wasCompleted
                ? enrollment.totalSchoolFee
                : enrollment.remainingBalance,
          },
          metadata: {
            reference,
            eventType,
            amount: payment.amountPaid,
            wasActive,
            wasCompleted,
          },
        },
        tx,
      );

      const parentNotification = await tx.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'Payment Disputed / Reversed',
          message: `Your first payment of ${Money.fromKobo(payment.amountPaid).formatNaira()} for ${enrollment.child.fullName} (${enrollment.className}) at ${enrollment.school.name} has been reversed due to a "${eventType}" event. Please contact the school or re-enroll.`,
          type: NotificationType.ALERT,
          link: '/history',
        },
      });

      if (enrollment.school.ownerId) {
        await tx.notification.create({
          data: {
            userId: enrollment.school.ownerId,
            title: 'Payment Disputed / Reversed',
            message: `A first payment of ${Money.fromKobo(payment.amountPaid).formatNaira()} for ${enrollment.child.fullName} (${enrollment.className}) has been reversed due to a "${eventType}" event. The enrollment has been marked as FAILED.`,
            type: NotificationType.ALERT,
            link: '/school-owner-dashboard',
          },
        });
      }

      return parentNotification;
    });

    if (!flipped) return { reversed: false };

    // Written in-transaction (atomic with the reversal), so the socket push has to
    // happen here — losing someone's money needs to reach them live, not on the
    // next poll.
    this.events.pushNotification(enrollment.child.parent.userId, flipped);

    this.events.emitEnrollmentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: payment.schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('failed', {
      type: PaymentType.FIRST_PAYMENT,
      receiver: payment.receiver,
    });

    return { reversed: true };
  }

  /** Confirm a manual (non-Paystack) first payment and activate the enrollment. */
  async confirmFirstPayment(
    enrollmentId: string,
    schoolId: string,
    actor: AuditActor,
  ) {
    const txResult = await this.prisma.$transaction(async (tx) => {
      // 1. Verify Enrollment
      const enrollment = await tx.childEnrollment.findUnique({
        where: { id: enrollmentId },
        include: {
          child: { include: { parent: { include: { user: true } } } },
          school: true,
        },
      });

      if (!enrollment) {
        throw new BadRequestException('Enrollment not found');
      }

      if (enrollment.schoolId !== schoolId) {
        throw new BadRequestException(
          'Enrollment does not belong to this school',
        );
      }

      if (enrollment.paymentStatus !== PaymentStatus.PENDING) {
        throw new BadRequestException('Enrollment is not in pending status');
      }

      // 2. Find the pending MANUAL first payment. A Paystack-collected first
      // payment is PENDING from the moment the popup is opened, so without the
      // `paystackReference: null` filter a school owner could approve a card
      // payment the parent never completed — activating the enrollment and
      // crediting the deposit against money that was never captured.
      const payment = await tx.payment.findFirst({
        where: {
          enrollmentId: enrollmentId,
          paymentType: PaymentType.FIRST_PAYMENT,
          isConfirmed: false,
          paystackReference: null,
        },
      });

      if (!payment) {
        // Distinguish "nothing to approve" from "this one approves itself", so the
        // owner isn't left thinking the enrollment is broken.
        const cardPayment = await tx.payment.findFirst({
          where: {
            enrollmentId: enrollmentId,
            paymentType: PaymentType.FIRST_PAYMENT,
            isConfirmed: false,
            paystackReference: { not: null },
          },
          select: { id: true },
        });
        if (cardPayment) {
          throw new BadRequestException(
            'This first payment is collected by card and is confirmed automatically once the payment provider settles it.',
          );
        }
      }

      if (!payment) {
        throw new BadRequestException('No pending first payment found');
      }

      // 3. Update Payment (guarded — only an unconfirmed payment flips, so a
      // concurrent confirm/settle/reconcile can't double-activate or double-audit).
      const confirmed = await tx.payment.updateMany({
        where: { id: payment.id, isConfirmed: false },
        data: {
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
          paymentDate: new Date(),
        },
      });
      if (confirmed.count === 0) {
        throw new BadRequestException('First payment already processed');
      }

      // 4. Credit the school share and activate (or settle) the enrollment. The
      // payment flip above is the exactly-once guard for this decrement.
      const { remainingBalance, isCompleted } =
        await this.creditFirstPaymentToBalance(
          tx,
          enrollmentId,
          payment.schoolAmount,
        );

      // 4b. Audit (atomic with the confirmation/activation)
      await this.audit.record(
        {
          action: AuditAction.FIRST_PAYMENT_CONFIRMED,
          entityType: 'Payment',
          entityId: payment.id,
          actor,
          schoolId,
          before: {
            paymentStatus: PaymentStatus.PENDING,
            isConfirmed: payment.isConfirmed,
            remainingBalance: enrollment.remainingBalance,
          },
          after: {
            paymentStatus: isCompleted
              ? PaymentStatus.COMPLETED
              : PaymentStatus.ACTIVE,
            isConfirmed: true,
            remainingBalance,
          },
          metadata: { enrollmentId, amount: payment.amountPaid },
        },
        tx,
      );

      // 5. Notify Parent
      await this.notificationsService.create({
        userId: enrollment.child.parent.userId,
        title: 'Enrollment Confirmed',
        message: `Your enrollment for ${enrollment.child.fullName} (${enrollment.className}) at ${enrollment.school.name} has been confirmed.`,
        link: '/dashboard',
      });

      return {
        message: 'First payment confirmed and enrollment activated',
        parentUserId: enrollment.child.parent.userId,
        submittedAt: payment.paymentDate,
        receiver: payment.receiver,
      };
    });
    const { parentUserId, submittedAt, receiver } = txResult;

    // Enrollment just went ACTIVE — push to the parent (their dashboard),
    // school dashboard, and admins.
    this.events.emitEnrollmentsChanged({
      parentUserId,
      schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      parentUserId,
      schoolId,
      notifyAdmins: true,
    });

    this.metrics.recordPaymentOutcome('confirmed', {
      type: PaymentType.FIRST_PAYMENT,
      receiver,
      latencySeconds: LedgerService.latencySeconds(submittedAt),
    });

    return { message: 'First payment confirmed and enrollment activated' };
  }

  /** Mark an enrollment DEFAULTED (manual, school-initiated). */
  async markEnrollmentAsDefaulted(
    enrollmentId: string,
    schoolId: string,
    actor: AuditActor,
  ) {
    const enrollment = await this.prisma
      .withTenant(schoolId)
      .childEnrollment.findFirst({
        where: { id: enrollmentId },
        include: { school: true, child: { include: { parent: true } } },
      });

    if (!enrollment) {
      throw new BadRequestException('Enrollment not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Mark as Defaulted
      const updatedEnrollment = await tx.childEnrollment.update({
        where: { id: enrollmentId },
        data: { paymentStatus: PaymentStatus.DEFAULTED },
      });

      // 1b. Audit (atomic with the status change)
      await this.audit.record(
        {
          action: AuditAction.ENROLLMENT_DEFAULTED,
          entityType: 'ChildEnrollment',
          entityId: enrollmentId,
          actor,
          schoolId,
          before: { paymentStatus: enrollment.paymentStatus },
          after: { paymentStatus: PaymentStatus.DEFAULTED },
          metadata: { remainingBalance: enrollment.remainingBalance },
        },
        tx,
      );

      // 2. Notify Parent
      await this.notificationsService.create({
        userId: enrollment.child.parent.userId,
        title: 'Payment Defaulted',
        message: `Your enrollment for ${enrollment.child.fullName} (${enrollment.className}) at ${enrollment.school.name} has been marked as defaulted. Please contact the school.`,
        type: NotificationType.ALERT,
        link: '/history',
      });

      return updatedEnrollment;
    });

    this.events.emitEnrollmentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId,
      notifyAdmins: true,
    });

    return result;
  }

  /**
   * Default a single overdue enrollment from the scheduled sweep (system action,
   * `actor: null`). Per-row guarded flip so an enrollment paid/completed since
   * the sweep snapshot is neither wrongly defaulted nor notified twice. Returns
   * whether this row actually flipped (so the caller can log/skip).
   */
  async markEnrollmentDefaultedBySweep(enrollment: {
    id: string;
    schoolId: string;
    remainingBalance: number;
    child: { fullName: string; parent: { userId: string } };
    school: { name: string };
  }): Promise<boolean> {
    const flipped = await this.prisma.$transaction(async (tx) => {
      const res = await tx.childEnrollment.updateMany({
        where: {
          id: enrollment.id,
          paymentStatus: PaymentStatus.ACTIVE,
          remainingBalance: { gt: 0 },
        },
        data: { paymentStatus: PaymentStatus.DEFAULTED },
      });
      if (res.count === 0) return false;

      // Audit (atomic). actor is null — this is a system action.
      await this.audit.record(
        {
          action: AuditAction.ENROLLMENT_DEFAULTED,
          entityType: 'ChildEnrollment',
          entityId: enrollment.id,
          actor: null,
          schoolId: enrollment.schoolId,
          before: { paymentStatus: PaymentStatus.ACTIVE },
          after: { paymentStatus: PaymentStatus.DEFAULTED },
          metadata: {
            remainingBalance: enrollment.remainingBalance,
            source: 'scheduled-defaulter-detection',
          },
        },
        tx,
      );

      return tx.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'Payment Defaulted',
          message: `Your enrollment for ${enrollment.child.fullName} at ${enrollment.school.name} has been marked as defaulted due to outstanding balance of ${Money.fromKobo(enrollment.remainingBalance).formatNaira()}.`,
          type: NotificationType.ALERT,
          link: '/history',
        },
      });
    });

    if (!flipped) return false;

    // Written inside the transaction (atomic with the flip) rather than through
    // NotificationsService, so the socket push has to be made here. Without it the
    // parent's notification list only picked this up on the 5-minute fallback poll
    // — every other notification in the system arrives live.
    this.events.pushNotification(enrollment.child.parent.userId, flipped);

    this.events.emitEnrollmentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: enrollment.schoolId,
      notifyAdmins: true,
    });
    return true;
  }
}
