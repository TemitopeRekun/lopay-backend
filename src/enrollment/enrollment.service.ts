import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentStatus,
  PaymentType,
  PaymentReceiver,
  UserRole,
  PaymentTransactionStatus,
  AuditAction,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentDto } from './dto/create.enrollment.dto';
import { PaymentService } from '../payments/payment.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService, AuditActor } from '../audit/audit.service';
import { Money } from '../common/money';
import { PaystackService } from '../paystack/paystack.service';
import { grossUp } from '../common/paystack-fee';
import { randomUUID } from 'crypto';

type EnrollmentWithRelations = Prisma.ChildEnrollmentGetPayload<{
  include: { child: true; school: true; payments: true };
}>;

type PaymentRecord = EnrollmentWithRelations['payments'][number];

type PaymentWithEnrollment = Prisma.PaymentGetPayload<{
  include: { enrollment: { include: { child: true; school: true } } };
}>;

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly notificationsService: NotificationsService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
    private readonly paystack: PaystackService,
  ) {}

  /**
   * Resolve the parent, child, and any retryable (FAILED) enrollment for an
   * enrollment request. Shared by the manual `enrollChild` flow and the Paystack
   * `initiateFirstPayment` flow. Creates a Parent/Child record when needed.
   */
  private async resolveEnrollmentTarget(
    dto: CreateEnrollmentDto,
    userId: string,
  ): Promise<{ parent: { id: string }; childId: string; retryEnrollmentId: string | null }> {
    let childId = dto.childId;
    let retryEnrollmentId: string | null = null;

    let parent = await this.prisma.parent.findUnique({ where: { userId } });
    if (!parent) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { school: true },
      });
      if (user && user.role === UserRole.SCHOOL_OWNER && user.school) {
        parent = await this.prisma.parent.create({
          data: { userId: user.id, phoneNumber: user.school.phone },
        });
      } else {
        throw new BadRequestException('Parent profile not found');
      }
    }

    if (childId) {
      const child = await this.prisma.child.findUnique({ where: { id: childId } });
      if (!child || child.parentId !== parent.id) {
        throw new BadRequestException('Child not found or does not belong to user');
      }
    } else if (dto.childName) {
      const failedEnrollment = await this.prisma.childEnrollment.findFirst({
        where: {
          paymentStatus: PaymentStatus.FAILED,
          schoolId: dto.schoolId,
          child: {
            parentId: parent.id,
            fullName: dto.childName,
            className: dto.className,
          },
        },
      });
      if (failedEnrollment) {
        this.logger.log(`Retrying failed enrollment: ${failedEnrollment.id}`);
        childId = failedEnrollment.childId;
        retryEnrollmentId = failedEnrollment.id;
      } else {
        const newChild = await this.prisma.child.create({
          data: {
            fullName: dto.childName,
            parentId: parent.id,
            className: dto.className,
          },
        });
        childId = newChild.id;
      }
    } else {
      throw new BadRequestException('Either childId or childName must be provided');
    }

    // Only FAILED enrollments may be retried; everything else is a conflict.
    const existingEnrollment = await this.prisma.childEnrollment.findUnique({
      where: { childId },
    });
    if (existingEnrollment) {
      if (existingEnrollment.paymentStatus !== PaymentStatus.FAILED) {
        throw new BadRequestException('Enrollment already exists for this child');
      }
      if (existingEnrollment.schoolId !== dto.schoolId) {
        throw new BadRequestException('Failed enrollment belongs to a different school');
      }
      retryEnrollmentId = existingEnrollment.id;
    }

    return { parent, childId, retryEnrollmentId };
  }

  /** Look up an already-recorded payment by its client idempotency key. */
  private findPaymentByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PaymentWithEnrollment | null> {
    return this.prisma.payment.findUnique({
      where: { idempotencyKey },
      include: { enrollment: { include: { child: true, school: true } } },
    });
  }

  /**
   * True when an error is the unique-constraint violation on `idempotencyKey`
   * (i.e. a concurrent request with the same key won the race).
   */
  private isIdempotencyConflict(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }
    const target = error.meta?.target;
    return Array.isArray(target)
      ? target.includes('idempotencyKey')
      : String(target ?? '').includes('idempotencyKey');
  }

  /** Shape an existing first-payment row into the enrollment API response. */
  private buildEnrollmentReplay(payment: PaymentWithEnrollment) {
    return {
      idempotent: true,
      enrollment: payment.enrollment,
      payment,
      school: payment.enrollment?.school ?? null,
      childName: payment.enrollment?.child?.fullName,
      studentName: payment.enrollment?.child?.fullName,
    };
  }

  /** Shape an installment payment row into the enriched API response (naira). */
  private buildInstallmentResponse(payment: PaymentWithEnrollment) {
    return {
      ...payment,
      amount: Money.fromKobo(payment.amountPaid).toNaira(),
      amountPaid: Money.fromKobo(payment.amountPaid).toNaira(),
      date: payment.paymentDate,
      type: payment.paymentType,
      studentName: payment.enrollment?.child?.fullName,
      childName: payment.enrollment?.child?.fullName,
      schoolName: payment.enrollment?.school?.name,
    };
  }

  private calculateEnrichment(enrollment: EnrollmentWithRelations, payments: PaymentRecord[]) {
    const confirmedPayments = payments.filter((p) => p.isConfirmed);
    // Arithmetic in kobo; convert to naira only for the returned object.
    const paidAmountKobo = confirmedPayments.reduce(
      (sum, p) => sum + p.amountPaid,
      0,
    );

    let nextDueDate: Date | null = null;
    let nextInstallmentAmountKobo = 0;

    if (enrollment.remainingBalance > 0) {
      const lastPayment = confirmedPayments[0];

      if (lastPayment) {
        const lastDate = new Date(lastPayment.paymentDate);
        if (enrollment.installmentFrequency === 'WEEKLY') {
          lastDate.setDate(lastDate.getDate() + 7);
        } else if (enrollment.installmentFrequency === 'MONTHLY') {
          lastDate.setMonth(lastDate.getMonth() + 1);
        }
        nextDueDate = lastDate;
      } else {
        nextDueDate = enrollment.termStartDate || enrollment.createdAt;
      }

      const plan = enrollment.installmentFrequency;
      const totalInstallments = plan === 'WEEKLY' ? 12 : 3;
      const paidInstallments = confirmedPayments.filter(
        (p) => p.paymentType === PaymentType.INSTALLMENT,
      ).length;
      const remainingInstallments = totalInstallments - paidInstallments;

      nextInstallmentAmountKobo = remainingInstallments > 0
        ? Math.round(enrollment.remainingBalance / remainingInstallments)
        : enrollment.remainingBalance;
    }

    // Enrich payments — convert kobo amounts to naira.
    const enrichedPayments = payments.map((p) => ({
      ...p,
      amount: Money.fromKobo(p.amountPaid).toNaira(),
      amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
      date: p.paymentDate,
      type: p.paymentType,
    }));

    return {
      ...enrollment,
      payments: enrichedPayments,
      studentName: enrollment.child?.fullName,
      childName: enrollment.child?.fullName,
      totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
      remainingBalance: Money.fromKobo(enrollment.remainingBalance).toNaira(),
      paidAmount: Money.fromKobo(paidAmountKobo).toNaira(),
      nextDueDate: nextDueDate ? nextDueDate.toISOString().split('T')[0] : null,
      nextInstallmentAmount: Money.fromKobo(nextInstallmentAmountKobo).toNaira(),
    };
  }

  async getParentEnrollments(userId: string) {
    this.logger.log(`Fetching enrollments for userId: ${userId}`);

    // Step 1: Find Parent
    const parent = await this.prisma.parent.findUnique({
      where: { userId },
      include: { children: true },
    });

    if (!parent) {
      this.logger.log(`Parent not found for userId: ${userId}`);
      return [];
    }
    this.logger.log(`Parent found. ID: ${parent.id}. Children: ${parent.children.length}`);

    if (parent.children.length === 0) {
      return [];
    }

    const childIds = parent.children.map((c) => c.id);

    // Step 2: Find Enrollments for these children
    const enrollments = await this.prisma.childEnrollment.findMany({
      where: {
        childId: { in: childIds },
      },
      include: {
        child: true,
        school: true,
        payments: {
          orderBy: { paymentDate: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    this.logger.log(`Found ${enrollments.length} enrollments for userId: ${userId}`);

    return enrollments.map((enrollment) =>
      this.calculateEnrichment(enrollment, enrollment.payments),
    );
  }

  async getEnrollmentHistory(enrollmentId: string, userId: string) {
    const enrollment = await this.prisma.childEnrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        child: { include: { parent: true } },
        payments: { orderBy: { paymentDate: 'desc' } },
        school: true,
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    if (enrollment.child.parent.userId !== userId) {
      throw new BadRequestException(
        'Unauthorized access to enrollment history',
      );
    }

    return this.calculateEnrichment(enrollment, enrollment.payments);
  }

  async enrollChild(dto: CreateEnrollmentDto, userId: string) {
    // 0. Idempotency: if we've already processed this exact submission, replay
    // the original outcome instead of creating a second enrollment/payment.
    if (dto.idempotencyKey) {
      const existing = await this.findPaymentByIdempotencyKey(
        dto.idempotencyKey,
      );
      if (existing) {
        return this.buildEnrollmentReplay(existing);
      }
    }

    // 1. Resolve Child + any retryable enrollment
    const { childId, retryEnrollmentId } = await this.resolveEnrollmentTarget(
      dto,
      userId,
    );

    // 2. Get Fees
    const classFee = await this.prisma.classFee.findFirst({
      where: {
        schoolId: dto.schoolId,
        className: dto.className,
        isActive: true,
      },
    });

    if (!classFee) {
      throw new BadRequestException(
        `No fee configuration found for class ${dto.className} in this school`,
      );
    }

    // 3. Calculate Deposit — convert both to kobo; DB stores kobo.
    const depositKobo = Money.fromNaira(dto.firstPaymentPaid).toKobo();
    const calculation = this.paymentService.calculateInitialPayment(
      classFee.feeAmount,    // already kobo (stored by createClassFee)
      depositKobo,
    );

    // 4. Create Enrollment & Payment
    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
      let enrollment;
      if (retryEnrollmentId) {
        this.logger.log(`Retrying first payment for enrollmentId: ${retryEnrollmentId}`);
        enrollment = await tx.childEnrollment.update({
          where: { id: retryEnrollmentId },
          data: {
            className: dto.className,
            totalSchoolFee: calculation.schoolFees,       // kobo
            platformFee: calculation.platformFee,          // kobo
            schoolMinimumFee: calculation.minimumDeposit,  // kobo
            firstPaymentPaid: depositKobo,                 // kobo
            remainingBalance: calculation.remainingBalance, // kobo
            paymentStatus: PaymentStatus.PENDING,
            installmentFrequency: dto.installmentFrequency,
            termStartDate: dto.termStartDate,
            termEndDate: dto.termEndDate,
          },
        });
      } else {
        this.logger.log(`Creating enrollment for childId: ${childId}, schoolId: ${dto.schoolId}`);
        enrollment = await tx.childEnrollment.create({
          data: {
            childId,
            schoolId: dto.schoolId,
            className: dto.className,
            totalSchoolFee: calculation.schoolFees,       // kobo
            platformFee: calculation.platformFee,          // kobo
            schoolMinimumFee: calculation.minimumDeposit,  // kobo
            firstPaymentPaid: depositKobo,                 // kobo
            remainingBalance: calculation.remainingBalance, // kobo
            paymentStatus: PaymentStatus.PENDING,
            installmentFrequency: dto.installmentFrequency,
            termStartDate: dto.termStartDate,
            termEndDate: dto.termEndDate,
          },
        });
      }

      const payment = await tx.payment.create({
        data: {
          enrollmentId: enrollment.id,
          schoolId: dto.schoolId,
          amountPaid: depositKobo,                  // kobo
          platformAmount: calculation.platformFee,   // kobo
          schoolAmount: calculation.amountToSchool,  // kobo
          receiver: PaymentReceiver.PLATFORM,
          paymentType: PaymentType.FIRST_PAYMENT,
          status: PaymentTransactionStatus.PENDING,
          isConfirmed: false,
          receiptUrl: dto.receiptUrl,
          idempotencyKey: dto.idempotencyKey ?? null,
          paymentDate: new Date(),
        },
      });

      const school = await tx.school.findUnique({
        where: { id: dto.schoolId },
      });

      // Fetch child name for notification
      const child = await tx.child.findUnique({
        where: { id: childId },
        select: { fullName: true },
      });
      const childName = child?.fullName || dto.childName || 'Student';

      return {
        enrollment,
        payment,
        calculation,
        school,
        childName,
        studentName: childName, // Alias for consistency
      };
      });
    } catch (error) {
      // A concurrent request with the same idempotency key won the race —
      // replay its result instead of surfacing a duplicate-key error.
      if (dto.idempotencyKey && this.isIdempotencyConflict(error)) {
        const existing = await this.findPaymentByIdempotencyKey(
          dto.idempotencyKey,
        );
        if (existing) return this.buildEnrollmentReplay(existing);
      }
      throw error;
    }

    // 5. Notify School Owner (Post-Transaction)
    if (result.school?.ownerId) {
      await this.notificationsService.create({
        userId: result.school.ownerId,
        title: 'New Enrollment Initiated',
        message: `New Student: ${result.childName} | Class: ${dto.className} | Amount Paid: ${Money.fromNaira(dto.firstPaymentPaid).formatNaira()} | Status: Pending Admin Transfer.`,
        link: '/school/pending-payments',
      });
    }

    // 6. Notify Super Admin (Platform)
    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN },
      select: { id: true },
    });

    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.create({
          userId: admin.id,
          title: 'New First Payment Received',
          message: `Payment of ${Money.fromNaira(dto.firstPaymentPaid).formatNaira()} received for ${result.childName} at ${result.school?.name}. Please process 25% payout to school.`,
          link: '/admin/payments',
        }),
      ),
    );

    // A new pending enrollment + first payment now awaits processing — push it
    // to the school owner and admins so their pending queues update live.
    this.events.emitEnrollmentsChanged({
      schoolId: dto.schoolId,
      notifyAdmins: true,
    });
    this.events.emitPaymentsChanged({
      schoolId: dto.schoolId,
      notifyAdmins: true,
    });

    return result;
  }

  /**
   * Initiate a first payment via Paystack split. Creates (or reuses) a PENDING
   * enrollment + PENDING payment, computes the platform/school split and the
   * grossed-up amount the parent pays, then initializes a Paystack transaction
   * whose split routes `platformFee` to the platform main account and the
   * deposit to the school subaccount. Activation happens on the webhook/verify.
   *
   * Returns the inline-popup `accessCode` + `reference` for the frontend.
   */
  async initiateFirstPayment(dto: CreateEnrollmentDto, userId: string) {
    // Idempotency: replay an in-flight/completed intent rather than double-charging.
    if (dto.idempotencyKey) {
      const existing = await this.findPaymentByIdempotencyKey(dto.idempotencyKey);
      if (existing) {
        return {
          idempotent: true,
          reference: existing.paystackReference,
          accessCode: existing.paystackAccessCode,
          amountCharged: existing.amountCharged
            ? Money.fromKobo(existing.amountCharged).toNaira()
            : null,
          status: existing.status,
        };
      }
    }

    const { childId, retryEnrollmentId } = await this.resolveEnrollmentTarget(
      dto,
      userId,
    );

    // Fee snapshot (kobo) + parent's chosen deposit (kobo).
    const classFee = await this.prisma.classFee.findFirst({
      where: { schoolId: dto.schoolId, className: dto.className, isActive: true },
    });
    if (!classFee) {
      throw new BadRequestException(
        `No fee configuration found for class ${dto.className} in this school`,
      );
    }

    const school = await this.prisma.school.findUnique({
      where: { id: dto.schoolId },
    });
    if (!school) throw new NotFoundException('School not found');
    if (!school.paystackSubaccountActive || !school.paystackSubaccountCode) {
      throw new BadRequestException(
        'This school is not set up to accept online payments yet.',
      );
    }

    // Validates min/max bounds and computes the platform/school split.
    const depositKobo = Money.fromNaira(dto.firstPaymentPaid).toKobo();
    const calc = this.paymentService.calculateInitialPayment(
      classFee.feeAmount,
      depositKobo,
    );

    // Gross up so Paystack's fee is added on top (school + platform nets preserved).
    // base = amountToSchool + platformFee = depositPaid.
    const base = calc.amountToSchool + calc.platformFee;
    const { amountCharged, paystackFee } = grossUp(base);
    const transactionCharge = calc.platformFee + paystackFee;

    // Parent's email for the Paystack customer record.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.email) throw new BadRequestException('Payer email not found');

    const reference = `lopay_${randomUUID()}`;

    // Create enrollment (PENDING) + payment (PENDING) atomically.
    let payment;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const enrollmentData = {
          className: dto.className,
          totalSchoolFee: calc.schoolFees,
          platformFee: calc.platformFee,
          schoolMinimumFee: calc.minimumDeposit,
          firstPaymentPaid: depositKobo,
          remainingBalance: calc.remainingBalance,
          paymentStatus: PaymentStatus.PENDING,
          installmentFrequency: dto.installmentFrequency,
          termStartDate: dto.termStartDate,
          termEndDate: dto.termEndDate,
        };

        const enrollment = retryEnrollmentId
          ? await tx.childEnrollment.update({
              where: { id: retryEnrollmentId },
              data: enrollmentData,
            })
          : await tx.childEnrollment.create({
              data: { childId, schoolId: dto.schoolId, ...enrollmentData },
            });

        return tx.payment.create({
          data: {
            enrollmentId: enrollment.id,
            schoolId: dto.schoolId,
            amountPaid: depositKobo, // net credited toward fees
            platformAmount: calc.platformFee,
            schoolAmount: calc.amountToSchool,
            amountCharged, // gross paid by parent (incl. paystack fee)
            transactionCharge,
            paystackFee, // estimate; reconciled from webhook
            paystackReference: reference,
            receiver: PaymentReceiver.PLATFORM,
            paymentType: PaymentType.FIRST_PAYMENT,
            status: PaymentTransactionStatus.PENDING,
            isConfirmed: false,
            idempotencyKey: dto.idempotencyKey ?? null,
            paymentDate: new Date(),
          },
        });
      });
    } catch (error) {
      if (dto.idempotencyKey && this.isIdempotencyConflict(error)) {
        const existing = await this.findPaymentByIdempotencyKey(dto.idempotencyKey);
        if (existing) {
          return {
            idempotent: true,
            reference: existing.paystackReference,
            accessCode: existing.paystackAccessCode,
            amountCharged: existing.amountCharged
              ? Money.fromKobo(existing.amountCharged).toNaira()
              : null,
            status: existing.status,
          };
        }
      }
      throw error;
    }

    // Initialize the Paystack split transaction.
    const init = await this.paystack.initializeTransaction({
      email: user.email,
      amountKobo: amountCharged,
      reference,
      subaccount: school.paystackSubaccountCode,
      transactionChargeKobo: transactionCharge,
      callbackUrl: process.env.PAYSTACK_CALLBACK_URL,
      metadata: {
        paymentId: payment.id,
        enrollmentId: payment.enrollmentId,
        schoolId: dto.schoolId,
        childId,
      },
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { paystackAccessCode: init.accessCode },
    });

    return {
      reference: init.reference,
      accessCode: init.accessCode,
      authorizationUrl: init.authorizationUrl,
      amountCharged: Money.fromKobo(amountCharged).toNaira(),
      depositToSchool: Money.fromKobo(calc.amountToSchool).toNaira(),
      platformFee: Money.fromKobo(calc.platformFee).toNaira(),
      paystackFee: Money.fromKobo(paystackFee).toNaira(),
    };
  }

  /**
   * Reconcile a Paystack first payment to SUCCESS. Shared by the webhook and the
   * verify-on-return endpoint, and idempotent: a payment already SUCCESS is a no-op.
   * Activates the enrollment (or marks it COMPLETED if paid in full).
   */
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
      this.logger.warn(`Paystack reconcile: no payment for reference ${reference}`);
      return { reconciled: false, reason: 'unknown_reference' };
    }
    if (payment.status === PaymentTransactionStatus.SUCCESS) {
      return { reconciled: true, alreadyProcessed: true };
    }

    const { enrollment } = payment;
    const newBalance = enrollment.remainingBalance; // already net of this deposit at initiation
    const isCompleted = newBalance <= 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentTransactionStatus.SUCCESS,
          isConfirmed: true,
          paystackFee: actualFeeKobo ?? payment.paystackFee,
          paymentDate: new Date(),
        },
      });

      await tx.childEnrollment.update({
        where: { id: enrollment.id },
        data: {
          paymentStatus: isCompleted
            ? PaymentStatus.COMPLETED
            : PaymentStatus.ACTIVE,
        },
      });

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
            paystackFee: actualFeeKobo ?? payment.paystackFee,
          },
        },
        tx,
      );
    });

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
      include: { enrollment: { include: { child: { include: { parent: true } } } } },
    });
    if (!payment || payment.status !== PaymentTransactionStatus.PENDING) {
      return { updated: false };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentTransactionStatus.FAILED },
      });
      await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
    });

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

  async submitInstallmentPayment(
    enrollmentId: string,
    amountPaid: number,
    receiptUrl?: string,
    idempotencyKey?: string,
  ) {
    // Idempotency: replay the original payment if this submission already ran.
    if (idempotencyKey) {
      const existing = await this.findPaymentByIdempotencyKey(idempotencyKey);
      if (existing) return this.buildInstallmentResponse(existing);
    }

    const enrollment = await this.prisma.childEnrollment.findUnique({
      where: { id: enrollmentId },
      include: { school: true, child: true },
    });

    if (!enrollment) throw new NotFoundException('Enrollment not found');

    // Convert Naira (from DTO/frontend) to kobo for DB storage.
    const amountPaidKobo = Money.fromNaira(amountPaid).toKobo();

    // Feature 2 — flexible amounts: the parent may pay any amount up to the
    // outstanding balance (a larger payment clears the balance faster and shrinks
    // the next recomputed installment). Reject non-positive and over-payment.
    if (amountPaidKobo <= 0) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }
    if (amountPaidKobo > enrollment.remainingBalance) {
      throw new BadRequestException(
        `Payment exceeds the outstanding balance of ${Money.fromKobo(
          enrollment.remainingBalance,
        ).formatNaira()}`,
      );
    }

    // Create Payment
    let payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          enrollmentId,
          schoolId: enrollment.schoolId,
          amountPaid: amountPaidKobo,    // kobo
          platformAmount: 0,
          schoolAmount: amountPaidKobo,   // kobo
          receiver: PaymentReceiver.SCHOOL,
          paymentType: PaymentType.INSTALLMENT,
          status: PaymentTransactionStatus.PENDING,
          isConfirmed: false,
          receiptUrl,
          idempotencyKey: idempotencyKey ?? null,
          paymentDate: new Date(),
        },
      });
    } catch (error) {
      // Lost the race to a concurrent request with the same key — replay it.
      if (idempotencyKey && this.isIdempotencyConflict(error)) {
        const existing = await this.findPaymentByIdempotencyKey(idempotencyKey);
        if (existing) return this.buildInstallmentResponse(existing);
      }
      throw error;
    }

    // Notify School Owner
    if (enrollment.school.ownerId) {
      await this.notificationsService.create({
        userId: enrollment.school.ownerId,
        title: 'New Installment Payment',
        message: `New payment of ${Money.fromNaira(amountPaid).formatNaira()} for ${enrollment.child.fullName} (${enrollment.className}) at ${enrollment.school.name}.`,
      });
    }

    // Push the new pending installment to the school dashboard + admins.
    this.events.emitPaymentsChanged({
      schoolId: enrollment.schoolId,
      notifyAdmins: true,
    });

    return {
      ...payment,
      amount: payment.amountPaid, // Alias
      date: payment.paymentDate, // Alias
      type: payment.paymentType, // Alias
      studentName: enrollment.child.fullName, // Alias
      childName: enrollment.child.fullName, // Alias
      schoolName: enrollment.school.name, // Alias
    };
  }

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

      // 3. Update Payment
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
          paymentDate: new Date(),
        },
      });

      // 4. Activate Enrollment
      await tx.childEnrollment.update({
        where: { id: enrollmentId },
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
}
