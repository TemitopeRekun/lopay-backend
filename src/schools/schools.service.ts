import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaymentStatus,
  UserRole,
  PaymentTransactionStatus,
  PaymentType,
  AuditAction,
  Prisma,
} from '../generated/prisma/client';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { CreateSchoolDto } from '../admin/dto/create.school.dto';
import { UpdateSchoolDto } from './dto/update.school.dto';
import { DocumentsService } from '../documents/documents.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService, AuditActor } from '../audit/audit.service';
import { Money } from '../common/money';

@Injectable()
export class SchoolPaymentsService {
  private readonly logger = new Logger(SchoolPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly documentsService: DocumentsService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
  ) {}

  async createSchool(dto: CreateSchoolDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingUser) {
      throw new BadRequestException(
        'User with this email already exists in the database',
      );
    }

    // 1. Create the owner via Better Auth (User + credential account).
    let ownerUserId: string;
    try {
      const signUp = await this.authService.api.signUpEmail({
        body: {
          email: dto.ownerEmail,
          password: dto.ownerPassword,
          name: dto.ownerName,
        } as any,
      });
      ownerUserId = signUp.user.id;
      // role is not a sign-up input (security); elevate to SCHOOL_OWNER server-side.
      await this.prisma.user.update({
        where: { id: ownerUserId },
        data: { role: UserRole.SCHOOL_OWNER },
      });
    } catch (error: any) {
      throw new BadRequestException(
        `Could not create owner account: ${error?.message ?? 'unknown error'}`,
      );
    }

    // 2. Create the School row; roll back the orphan auth user on failure.
    try {
      const school = await this.prisma.school.create({
        data: {
          name: dto.schoolName,
          email: dto.ownerEmail,
          address: dto.address,
          phone: dto.phone,
          bankName: dto.bankName ?? '',
          bankCode: dto.bankCode,
          accountName: dto.accountName ?? '',
          accountNumber: dto.accountNumber ?? '',
          ownerId: ownerUserId,
        },
      });
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
      });

      return {
        school,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          fullName: user.fullName,
        },
        message: 'School and School Owner created successfully',
      };
    } catch (error) {
      await this.prisma.user
        .delete({ where: { id: ownerUserId } })
        .catch(() => undefined);
      throw error;
    }
  }

  async updateSchool(id: string, dto: UpdateSchoolDto) {
    const school = await this.prisma.school.findFirst({ where: { id, deletedAt: null } });
    if (!school) throw new NotFoundException('School not found');

    return this.prisma.school.update({
      where: { id },
      data: {
        name: dto.schoolName,
        address: dto.address,
        phone: dto.phone,
        bankName: dto.bankName,
        accountName: dto.accountName,
        accountNumber: dto.accountNumber,
      },
    });
  }

  async getSchoolBankDetails(
    schoolId: string,
    user: { userId: string; role: UserRole; schoolId?: string | null },
  ) {
    // Bank account details are sensitive (fraud/redirection risk). Restrict to:
    // the owning school owner, a super admin, or a parent who actually has an
    // enrollment at this school — so they can't be mass-harvested by iterating
    // schoolIds.
    if (user.role === UserRole.SCHOOL_OWNER) {
      if (user.schoolId !== schoolId) {
        throw new ForbiddenException('You can only view your own school details');
      }
    } else if (user.role === UserRole.PARENT) {
      const hasEnrollment = await this.prisma.childEnrollment.findFirst({
        where: { schoolId, child: { parent: { userId: user.userId } } },
        select: { id: true },
      });
      if (!hasEnrollment) {
        throw new ForbiddenException(
          'You can only view bank details for a school you are enrolled with',
        );
      }
    } else if (user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Not authorized to view bank details');
    }

    const school = await this.prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
      select: {
        bankName: true,
        accountName: true,
        accountNumber: true,
      },
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    return school;
  }

  async updateSchoolBankDetails(schoolId: string, dto: UpdateSchoolDto) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });
    if (!school) {
      throw new NotFoundException('School not found');
    }

    return this.prisma.school.update({
      where: { id: schoolId },
      data: {
        bankName: dto.bankName,
        accountName: dto.accountName,
        accountNumber: dto.accountNumber,
      },
    });
  }

  async deleteSchool(id: string) {
    const school = await this.prisma.school.findFirst({
      where: { id, deletedAt: null },
    });
    if (!school) throw new NotFoundException('School not found');

    return this.prisma.school.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async getAllSchools(search?: string) {
    this.logger.log(`getAllSchools called with search: "${search ?? ''}"`);
    const where: Prisma.SchoolWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const schools = await this.prisma.school.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        address: true,
        phone: true,
      },
      orderBy: { name: 'asc' },
    });
    this.logger.log(`getAllSchools found ${schools.length} schools`);
    return schools;
  }

  async createClassFee(schoolId: string, className: string, feeAmount: number) {
    const feeKobo = Money.fromNaira(feeAmount).toKobo();
    const db = this.prisma.withTenant(schoolId);
    const existingFee = await db.classFee.findFirst({ where: { className } });

    if (existingFee) {
      return this.prisma.classFee.update({
        where: { id: existingFee.id },
        data: { feeAmount: feeKobo, isActive: true },
      });
    }

    return this.prisma.classFee.create({
      data: { schoolId, className, feeAmount: feeKobo },
    });
  }

  async getClassFees(schoolId: string) {
    const fees = await this.prisma.withTenant(schoolId).classFee.findMany({
      where: { isActive: true },
      orderBy: { className: 'asc' },
    });
    return fees.map((f) => ({ ...f, feeAmount: Money.fromKobo(f.feeAmount).toNaira() }));
  }

  async getDashboardStats(schoolId: string) {
    const db = this.prisma.withTenant(schoolId);
    const [totalStudents, confirmedPayments, pendingPayments, enrollments] =
      await Promise.all([
        // 1. Total Enrolled Students
        db.childEnrollment.count({}),

        // 2. Confirmed Payments (School Revenue)
        this.prisma.payment.aggregate({
          where: { schoolId, isConfirmed: true },
          _sum: { schoolAmount: true },
        }),

        // 3. Pending Payments — sum the SCHOOL's share, not the gross deposit.
        // For first payments amountPaid includes the 2.5% platform fee, which is
        // not owed to the school; schoolAmount is the school's actual share.
        this.prisma.payment.aggregate({
          where: { schoolId, isConfirmed: false },
          _sum: { schoolAmount: true },
        }),

        // 4. Defaulted Amount (from defaulted enrollments)
        db.childEnrollment.findMany({
          where: { paymentStatus: PaymentStatus.DEFAULTED },
          select: { remainingBalance: true },
        }),
      ]);

    // DB stores kobo; return Naira for API consumers.
    const totalRevenue = Money.fromKobo(confirmedPayments._sum.schoolAmount || 0).toNaira();
    const pendingRevenue = Money.fromKobo(pendingPayments._sum.schoolAmount || 0).toNaira();
    const defaultedAmount = Money.fromKobo(
      enrollments.reduce((sum, e) => sum + e.remainingBalance, 0),
    ).toNaira();

    return {
      totalStudents,
      totalRevenue,
      pendingRevenue,
      defaultedAmount,
    };
  }

  async getStudents(
    schoolId: string,
    className?: string,
    search?: string,
    page = 1,
    limit = 50,
  ) {
    const take = Math.min(limit, 200);
    const skip = (page - 1) * take;
    const db = this.prisma.withTenant(schoolId);
    const whereClause: Prisma.ChildEnrollmentWhereInput = {};
    if (className) {
      whereClause.className = className;
    }
    if (search) {
      whereClause.OR = [
        { child: { fullName: { contains: search, mode: 'insensitive' } } },
        {
          child: {
            parent: {
              user: { fullName: { contains: search, mode: 'insensitive' } },
            },
          },
        },
      ];
    }

    const [enrollments, total] = await Promise.all([
      db.childEnrollment.findMany({
        where: whereClause,
        include: {
          child: { include: { parent: { include: { user: true } } } },
          payments: { orderBy: { paymentDate: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      db.childEnrollment.count({ where: whereClause }),
    ]);

    const items = enrollments.map((enrollment) => {
      const confirmedPayments = enrollment.payments.filter(
        (p) => p.isConfirmed,
      );
      const paidAmount = confirmedPayments.reduce(
        (sum, p) => sum + p.amountPaid,
        0,
      );

      // Calculate next due date (simplified logic)
      let nextDueDate: Date | null = null;
      if (enrollment.remainingBalance > 0 && confirmedPayments.length > 0) {
        const lastPayment = confirmedPayments[0];
        const lastDate = new Date(lastPayment.paymentDate);
        if (enrollment.installmentFrequency === 'WEEKLY') {
          lastDate.setDate(lastDate.getDate() + 7);
        } else {
          lastDate.setMonth(lastDate.getMonth() + 1);
        }
        nextDueDate = lastDate;
      } else if (enrollment.remainingBalance > 0) {
        // If no payments yet, due date is start date
        nextDueDate = enrollment.termStartDate;
      }

      return {
        id: enrollment.childId,
        studentName: enrollment.child.fullName,
        childName: enrollment.child.fullName,
        className: enrollment.className,
        parentName: enrollment.child.parent.user.fullName || 'Unknown',
        totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
        paidAmount: Money.fromKobo(paidAmount).toNaira(),
        paymentStatus: enrollment.paymentStatus,
        nextDueDate: nextDueDate
          ? nextDueDate.toISOString().split('T')[0]
          : null,
        avatarUrl: null,
      };
    });

    return { items, total, page, limit: take, totalPages: Math.ceil(total / take) };
  }

  async getHistory(
    schoolId: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
    take = 100,
  ) {
    const cappedTake = Math.min(take, 200);
    const baseWhere: Prisma.PaymentWhereInput =
      receiptType !== 'ALL' ? { paymentType: receiptType as any } : {};

    const payments = await this.prisma.withTenant(schoolId).payment.findMany({
      where: baseWhere,
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
      take: cappedTake,
    });

    const toPaymentDto = (payment: (typeof payments)[0], receiptSignedUrl?: string | null) => ({
      id: payment.id,
      schoolId: payment.schoolId,
      date: payment.paymentDate,
      paymentDate: payment.paymentDate,
      amount: Money.fromKobo(payment.amountPaid).toNaira(),
      amountPaid: Money.fromKobo(payment.amountPaid).toNaira(),
      studentName: payment.enrollment.child.fullName,
      childName: payment.enrollment.child.fullName,
      className: payment.enrollment.className,
      schoolName: payment.enrollment.school.name,
      type: payment.paymentType,
      paymentType: payment.paymentType,
      status: payment.status,
      receiptUrl: payment.receiptUrl,
      ...(receiptSignedUrl !== undefined ? { receiptSignedUrl } : {}),
    });

    if (!includeReceiptSignedUrls) {
      return payments.map((payment) => toPaymentDto(payment));
    }

    const shouldSign = (paymentType: string) =>
      receiptType === 'ALL' || paymentType === receiptType;

    const enriched = await Promise.all(
      payments.map(async (payment) => {
        let receiptSignedUrl: string | null = null;
        if (payment.receiptUrl && shouldSign(payment.paymentType)) {
          try {
            receiptSignedUrl = (
              await this.documentsService.createSignedUrlForPath(
                payment.receiptUrl,
              )
            ).signedUrl;
          } catch {
            receiptSignedUrl = null;
          }
        }

        return toPaymentDto(payment, receiptSignedUrl);
      }),
    );

    return enriched;
  }

  async getPendingPayments(
    schoolId: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
    take = 100,
  ) {
    const cappedTake = Math.min(take, 200);
    const payments = await this.prisma.withTenant(schoolId).payment.findMany({
      where: {
        isConfirmed: false,
        paymentType: 'INSTALLMENT',
        status: PaymentTransactionStatus.PENDING,
      },
      take: cappedTake,
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
    });

    const toPendingDto = (p: (typeof payments)[0], receiptSignedUrl?: string | null) => ({
      ...p,
      date: p.paymentDate,
      amount: Money.fromKobo(p.amountPaid).toNaira(),
      amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
      platformAmount: Money.fromKobo(p.platformAmount).toNaira(),
      schoolAmount: Money.fromKobo(p.schoolAmount).toNaira(),
      studentName: p.enrollment?.child?.fullName,
      childName: p.enrollment?.child?.fullName,
      className: p.enrollment?.className,
      schoolName: p.enrollment?.school?.name,
      ...(receiptSignedUrl !== undefined ? { receiptSignedUrl } : {}),
    });

    if (!includeReceiptSignedUrls) {
      return payments.map((p) => toPendingDto(p));
    }

    const shouldSign = (paymentType: string) =>
      receiptType === 'ALL' || paymentType === receiptType;

    const enriched = await Promise.all(
      payments.map(async (p) => {
        let receiptSignedUrl: string | null = null;
        if (p.receiptUrl && shouldSign(p.paymentType)) {
          try {
            receiptSignedUrl = (
              await this.documentsService.createSignedUrlForPath(p.receiptUrl)
            ).signedUrl;
          } catch {
            receiptSignedUrl = null;
          }
        }

        return toPendingDto(p, receiptSignedUrl);
      }),
    );

    return enriched;
  }

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
      const confirmedAmountStr = Money.fromKobo(payment.amountPaid).formatNaira();
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

  async markEnrollmentAsDefaulted(
    enrollmentId: string,
    schoolId: string,
    actor: AuditActor,
  ) {
    const enrollment = await this.prisma.withTenant(schoolId).childEnrollment.findFirst({
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
          paymentStatus: reopened
            ? PaymentStatus.ACTIVE
            : before.paymentStatus,
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
}
