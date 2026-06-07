import {
  Injectable,
  BadRequestException,
  Inject,
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
import * as admin from 'firebase-admin';
import { CreateSchoolDto } from '../admin/dto/create.school.dto';
import { UpdateSchoolDto } from './dto/update.school.dto';
import { DocumentsService } from '../documents/documents.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService, AuditActor } from '../audit/audit.service';

@Injectable()
export class SchoolPaymentsService {
  private readonly logger = new Logger(SchoolPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly documentsService: DocumentsService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
    @Inject('FIREBASE_ADMIN') private readonly firebaseAdmin: admin.app.App,
  ) {}

  async createSchool(dto: CreateSchoolDto) {
    // 1. Create Firebase User
    let firebaseUser;
    try {
      firebaseUser = await this.firebaseAdmin.auth().createUser({
        email: dto.ownerEmail,
        password: dto.ownerPassword,
        displayName: dto.ownerName,
      });
    } catch (error) {
      if (error.code === 'auth/email-already-exists') {
        try {
          firebaseUser = await this.firebaseAdmin
            .auth()
            .getUserByEmail(dto.ownerEmail);
        } catch (retrieveError: any) {
          throw new BadRequestException(
            `User exists in Firebase but could not be retrieved: ${retrieveError.message}`,
          );
        }
      } else {
        throw new BadRequestException(`Firebase Error: ${error.message}`);
      }
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingUser) {
      throw new BadRequestException(
        'User with this email already exists in the database',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 2. Create User record
      const user = await tx.user.create({
        data: {
          id: firebaseUser.uid,
          email: dto.ownerEmail,
          role: UserRole.SCHOOL_OWNER,
          fullName: dto.ownerName,
        },
      });

      // 3. Create School record
      const school = await tx.school.create({
        data: {
          name: dto.schoolName,
          email: dto.ownerEmail,
          address: dto.address,
          phone: dto.phone,
          bankName: '',
          accountName: '',
          accountNumber: '',
          ownerId: user.id,
          // logo: dto.logo, // School model might not have logo yet, checking schema... DTO has it.
        },
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
    });
  }

  async updateSchool(id: string, dto: UpdateSchoolDto) {
    const school = await this.prisma.school.findUnique({ where: { id } });
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

  async getSchoolBankDetails(schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
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
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found');

    // Might need to delete associated data or handle constraints
    // For MVP, just delete school (and cascading deletes if configured in Prisma)
    return this.prisma.school.delete({
      where: { id },
    });
  }

  async getAllSchools(search?: string) {
    this.logger.log(`getAllSchools called with search: "${search ?? ''}"`);
    const where: Prisma.SchoolWhereInput = {};
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
    // Check if fee already exists for this class
    const existingFee = await this.prisma.classFee.findFirst({
      where: {
        schoolId,
        className,
      },
    });

    if (existingFee) {
      // Update existing fee
      return this.prisma.classFee.update({
        where: { id: existingFee.id },
        data: { feeAmount, isActive: true },
      });
    }

    // Create new fee
    return this.prisma.classFee.create({
      data: {
        schoolId,
        className,
        feeAmount,
      },
    });
  }

  async getClassFees(schoolId: string) {
    return this.prisma.classFee.findMany({
      where: { schoolId, isActive: true },
      orderBy: { className: 'asc' },
    });
  }

  async getDashboardStats(schoolId: string) {
    const [totalStudents, confirmedPayments, pendingPayments, enrollments] =
      await Promise.all([
        // 1. Total Enrolled Students
        this.prisma.childEnrollment.count({
          where: { schoolId },
        }),

        // 2. Confirmed Payments (School Revenue)
        this.prisma.payment.aggregate({
          where: { schoolId, isConfirmed: true },
          _sum: { schoolAmount: true },
        }),

        // 3. Pending Payments (Unconfirmed amounts parents claim to have paid)
        this.prisma.payment.aggregate({
          where: { schoolId, isConfirmed: false },
          _sum: { amountPaid: true },
        }),

        // 4. Defaulted Amount (from defaulted enrollments)
        this.prisma.childEnrollment.findMany({
          where: { schoolId, paymentStatus: PaymentStatus.DEFAULTED },
          select: { remainingBalance: true },
        }),
      ]);

    const totalRevenue = confirmedPayments._sum.schoolAmount || 0;
    const pendingRevenue = pendingPayments._sum.amountPaid || 0;
    const defaultedAmount = enrollments.reduce(
      (sum, e) => sum + e.remainingBalance,
      0,
    );

    return {
      totalStudents,
      totalRevenue,
      pendingRevenue,
      defaultedAmount,
    };
  }

  async getStudents(schoolId: string, className?: string, search?: string) {
    const whereClause: Prisma.ChildEnrollmentWhereInput = { schoolId };
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

    const enrollments = await this.prisma.childEnrollment.findMany({
      where: whereClause,
      include: {
        child: { include: { parent: { include: { user: true } } } },
        payments: { orderBy: { paymentDate: 'desc' } }, // Fetch all payments to calculate paid amount
      },
    });

    return enrollments.map((enrollment) => {
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
        id: enrollment.childId, // Use childId as student ID
        studentName: enrollment.child.fullName,
        childName: enrollment.child.fullName, // Alias for consistency
        className: enrollment.className,
        parentName: enrollment.child.parent.user.fullName || 'Unknown',
        totalFee: enrollment.totalSchoolFee,
        paidAmount: paidAmount,
        paymentStatus: enrollment.paymentStatus,
        nextDueDate: nextDueDate
          ? nextDueDate.toISOString().split('T')[0]
          : null,
        avatarUrl: null, // Placeholder
      };
    });
  }

  async getHistory(
    schoolId: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
  ) {
    const payments = await this.prisma.payment.findMany({
      where: {
        schoolId,
      },
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
      orderBy: { paymentDate: 'desc' },
    });

    if (!includeReceiptSignedUrls) {
      return payments.map((payment) => ({
        id: payment.id,
        schoolId: payment.schoolId,
        date: payment.paymentDate,
        paymentDate: payment.paymentDate,
        amount: payment.amountPaid,
        amountPaid: payment.amountPaid,
        studentName: payment.enrollment.child.fullName,
        childName: payment.enrollment.child.fullName,
        className: payment.enrollment.className,
        schoolName: payment.enrollment.school.name,
        type: payment.paymentType,
        paymentType: payment.paymentType,
        status: payment.status,
        receiptUrl: payment.receiptUrl,
      }));
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
            // If the object no longer exists in storage, don't fail the whole list.
            receiptSignedUrl = null;
          }
        }

        return {
          id: payment.id,
          schoolId: payment.schoolId,
          date: payment.paymentDate,
          paymentDate: payment.paymentDate,
          amount: payment.amountPaid,
          amountPaid: payment.amountPaid,
          studentName: payment.enrollment.child.fullName,
          childName: payment.enrollment.child.fullName,
          className: payment.enrollment.className,
          schoolName: payment.enrollment.school.name,
          type: payment.paymentType,
          paymentType: payment.paymentType,
          status: payment.status,
          receiptUrl: payment.receiptUrl,
          receiptSignedUrl,
        };
      }),
    );

    return enriched;
  }

  async getPendingPayments(
    schoolId: string,
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
  ) {
    const payments = await this.prisma.payment.findMany({
      where: {
        schoolId: schoolId,
        isConfirmed: false,
        paymentType: 'INSTALLMENT',
        status: PaymentTransactionStatus.PENDING,
      },
      include: {
        enrollment: {
          include: {
            child: true,
            school: true,
          },
        },
      },
    });

    if (!includeReceiptSignedUrls) {
      return payments.map((p) => ({
        ...p,
        date: p.paymentDate,
        amount: p.amountPaid,
        studentName: p.enrollment?.child?.fullName,
        childName: p.enrollment?.child?.fullName,
        className: p.enrollment?.className,
        schoolName: p.enrollment?.school?.name,
      }));
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
            // If the object no longer exists in storage, don't fail the whole list.
            receiptSignedUrl = null;
          }
        }

        return {
          ...p,
          date: p.paymentDate,
          amount: p.amountPaid,
          studentName: p.enrollment?.child?.fullName,
          childName: p.enrollment?.child?.fullName,
          className: p.enrollment?.className,
          schoolName: p.enrollment?.school?.name,
          receiptSignedUrl,
        };
      }),
    );

    return enriched;
  }

  async confirmPayment(paymentId: string, schoolId: string, actor: AuditActor) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        schoolId,
        isConfirmed: false,
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
      // 1. Confirm Payment
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          isConfirmed: true,
          status: PaymentTransactionStatus.SUCCESS,
          paymentDate: new Date(),
        },
      });

      // 2. Update Enrollment Balance
      // Note: remainingBalance tracks what is LEFT to pay.
      const currentBalance = payment.enrollment.remainingBalance;
      const newBalance = currentBalance - payment.amountPaid;
      // If newBalance is effectively 0 (or less), mark completed.
      const isCompleted = newBalance <= 0;

      await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: {
          remainingBalance: Math.max(0, newBalance),
          paymentStatus: isCompleted
            ? PaymentStatus.COMPLETED
            : payment.enrollment.paymentStatus,
        },
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
            remainingBalance: currentBalance,
          },
          after: {
            status: PaymentTransactionStatus.SUCCESS,
            isConfirmed: true,
            remainingBalance: Math.max(0, newBalance),
            enrollmentStatus: isCompleted
              ? PaymentStatus.COMPLETED
              : payment.enrollment.paymentStatus,
          },
          metadata: { amount: payment.amountPaid, isCompleted },
        },
        tx,
      );

      // 3. Notify Parent
      let message = `Your payment of ${payment.amountPaid} for ${payment.enrollment.child.fullName} (${payment.enrollment.className}) at ${payment.enrollment.school.name} has been confirmed.`;
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
        amount: updatedPayment.amountPaid,
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
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        schoolId,
        isConfirmed: false,
      },
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
      // 1. Update Payment Status
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentTransactionStatus.FAILED,
          // isConfirmed stays false
        },
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
        message: `Your payment of ${payment.amountPaid} for ${payment.enrollment.child.fullName} at ${payment.enrollment.school.name} has been rejected. Please contact the school.`,
      });

      return {
        ...updatedPayment,
        amount: updatedPayment.amountPaid,
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
    const enrollment = await this.prisma.childEnrollment.findFirst({
      where: {
        id: enrollmentId,
        schoolId,
      },
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
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        schoolId,
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

    const currentBalance = payment.enrollment.remainingBalance;
    const restoredBalance = currentBalance + payment.amountPaid;
    // A reversal re-opens a completed enrollment.
    const reopened =
      payment.enrollment.paymentStatus === PaymentStatus.COMPLETED;

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Mark payment as reversed
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentTransactionStatus.REVERSED,
          isConfirmed: false,
        },
      });

      // 2. Restore the enrollment balance
      await tx.childEnrollment.update({
        where: { id: payment.enrollmentId },
        data: {
          remainingBalance: restoredBalance,
          paymentStatus: reopened
            ? PaymentStatus.ACTIVE
            : payment.enrollment.paymentStatus,
        },
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
            remainingBalance: currentBalance,
            enrollmentStatus: payment.enrollment.paymentStatus,
          },
          after: {
            status: PaymentTransactionStatus.REVERSED,
            isConfirmed: false,
            remainingBalance: restoredBalance,
            enrollmentStatus: reopened
              ? PaymentStatus.ACTIVE
              : payment.enrollment.paymentStatus,
          },
          metadata: { amount: payment.amountPaid, reopened },
        },
        tx,
      );

      // 4. Notify Parent
      await this.notificationsService.create({
        userId: payment.enrollment.child.parent.userId,
        title: 'Payment Reversed',
        message: `A confirmed payment of ${payment.amountPaid} for ${payment.enrollment.child.fullName} (${payment.enrollment.className}) at ${payment.enrollment.school.name} has been reversed.${reason ? ` Reason: ${reason}` : ''} Please contact the school.`,
      });

      return {
        ...updatedPayment,
        amount: updatedPayment.amountPaid,
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
