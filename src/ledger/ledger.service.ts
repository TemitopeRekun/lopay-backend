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
} from '../generated/prisma/client';
import { EventsGateway } from '../events/events.gateway';
import { AuditService, AuditActor } from '../audit/audit.service';
import { Money } from '../common/money';

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
  ) {}

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
          metadata: { amount: payment.amountPaid, isCompleted },
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

      // 4. Notify Parent
      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: 'Payment Reversed',
        message: `A confirmed payment of ${Money.fromKobo(payment.amountPaid).formatNaira()} for ${payment.enrollment.child.fullName} (${payment.enrollment.className}) at ${payment.enrollment.school.name} has been reversed.${reason ? ` Reason: ${reason}` : ''} Please contact the school.`,
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

    return result;
  }

  // ============================ first payments ============================

  /** Settle school share and activate enrollment */
  async settleFirstPayment(paymentId: string, actor: AuditActor) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
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

      // 2️⃣ Activate enrollment
      await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: { paymentStatus: PaymentStatus.ACTIVE },
      });

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
          },
          after: { isConfirmed: true, paymentStatus: PaymentStatus.ACTIVE },
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
          link: `/school/enrollments/${enrollment.id}`,
        },
      });

      // 4️⃣ Notify Parent
      await tx.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'Enrollment Confirmed',
          message: `Your first payment of ${Money.fromKobo(payment.amountPaid).formatNaira()} has been confirmed. Enrollment is active.`,
          link: `/parent/enrollments/${enrollment.id}`,
        },
      });
      return true;
    });

    if (!settled) {
      throw new NotFoundException('Payment not found or already settled');
    }

    return {
      message: 'Payment settled and enrollment activated successfully',
      paymentId: payment.id,
    };
  }

  /** Reject a pending first payment and mark enrollment as failed */
  async rejectFirstPayment(paymentId: string, actor: AuditActor) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
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
          link: `/school/enrollments/${enrollment.id}`,
        },
      });

      // 4️⃣ Notify Parent
      await tx.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'First Payment Rejected',
          message:
            'Your first payment could not be verified. Please pay again and upload a clearer receipt.',
          link: `/parent/enrollments/${enrollment.id}`,
        },
      });
      return true;
    });

    if (!rejectedOk) {
      throw new NotFoundException(
        'First payment not found or already processed',
      );
    }

    return {
      message: 'First payment rejected and enrollment marked as failed',
      paymentId: payment.id,
    };
  }

  // =========================== paystack reconcile ===========================

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

    const { enrollment } = payment;
    const newBalance = enrollment.remainingBalance; // already net of this deposit at initiation
    const isCompleted = newBalance <= 0;

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
        return false; // already reconciled by a concurrent caller
      }

      await tx.childEnrollment.update({
        where: { id: enrollment.id },
        data: {
          paymentStatus: isCompleted
            ? PaymentStatus.COMPLETED
            : PaymentStatus.ACTIVE,
        },
      });

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
          before: { status: payment.status, isConfirmed: payment.isConfirmed },
          after: {
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
            enrollmentStatus: isCompleted
              ? PaymentStatus.COMPLETED
              : PaymentStatus.ACTIVE,
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

      return true;
    });

    if (!processed) {
      return { reconciled: true, alreadyProcessed: true };
    }

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
        link: '/school/enrollments',
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

    if (payment.enrollment?.child?.parent?.userId) {
      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: 'Payment Failed',
        message: 'Your first payment did not go through. Please try again.',
        link: '/history',
      });
    }
    return { updated: true };
  }

  // ========================= enrollment lifecycle =========================

  /** Confirm a manual (non-Paystack) first payment and activate the enrollment. */
  async confirmFirstPayment(
    enrollmentId: string,
    schoolId: string,
    actor: AuditActor,
  ) {
    const { parentUserId } = await this.prisma.$transaction(async (tx) => {
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

      // 2. Find Pending First Payment
      const payment = await tx.payment.findFirst({
        where: {
          enrollmentId: enrollmentId,
          paymentType: PaymentType.FIRST_PAYMENT,
          isConfirmed: false,
        },
      });

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

      // 4. Activate Enrollment (guarded on the PENDING precondition)
      await tx.childEnrollment.updateMany({
        where: { id: enrollmentId, paymentStatus: PaymentStatus.PENDING },
        data: { paymentStatus: PaymentStatus.ACTIVE },
      });

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
          },
          after: {
            paymentStatus: PaymentStatus.ACTIVE,
            isConfirmed: true,
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
      });

      return {
        message: 'First payment confirmed and enrollment activated',
        parentUserId: enrollment.child.parent.userId,
      };
    });

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

      await tx.notification.create({
        data: {
          userId: enrollment.child.parent.userId,
          title: 'Payment Defaulted',
          message: `Your enrollment for ${enrollment.child.fullName} at ${enrollment.school.name} has been marked as defaulted due to outstanding balance of ${Money.fromKobo(enrollment.remainingBalance).formatNaira()}.`,
          link: '/history',
        },
      });
      return true;
    });

    if (!flipped) return false;

    this.events.emitEnrollmentsChanged({
      parentUserId: enrollment.child.parent.userId,
      schoolId: enrollment.schoolId,
      notifyAdmins: true,
    });
    return true;
  }
}
