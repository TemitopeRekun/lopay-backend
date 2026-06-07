import {
  Inject,
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentType,
  PaymentReceiver,
  PaymentStatus,
  PaymentTransactionStatus,
  UserRole,
  AuditAction,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import * as admin from 'firebase-admin';
import { CreateSchoolDto } from './dto/create.school.dto';
import { DocumentsService } from '../documents/documents.service';
import { AuditService, AuditActor } from '../audit/audit.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly documentsService: DocumentsService,
    private readonly audit: AuditService,
    @Inject('FIREBASE_ADMIN') private readonly firebaseAdmin: admin.app.App,
  ) {}

  /** Onboard a new school and create the school owner account */
  async onboardSchool(dto: CreateSchoolDto) {
    // 1. Create Firebase User
    let firebaseUser;
    try {
      this.logger.log(`Creating Firebase user: ${dto.ownerEmail}`);
      firebaseUser = await this.firebaseAdmin.auth().createUser({
        email: dto.ownerEmail,
        password: dto.ownerPassword,
        displayName: dto.ownerName,
      });
      this.logger.log(`Firebase user created: ${firebaseUser.uid}`);
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      this.logger.error(`Firebase user creation failed: ${err.message}`);
      if (err.code === 'auth/email-already-exists') {
        try {
          this.logger.log(`User exists in Firebase, retrieving: ${dto.ownerEmail}`);
          firebaseUser = await this.firebaseAdmin.auth().getUserByEmail(dto.ownerEmail);
          this.logger.log(`Retrieved existing Firebase user: ${firebaseUser.uid}`);
        } catch (retrieveError: unknown) {
          const re = retrieveError as { message?: string };
          throw new BadRequestException(
            `User exists in Firebase but could not be retrieved: ${re.message}`,
          );
        }
      } else {
        throw new BadRequestException(`Firebase Error: ${err.message}`);
      }
    }

    // If we are reusing an existing firebase user, we must ensure they don't already have a role that conflicts,
    // or we just overwrite/assign SCHOOL_OWNER role in our DB.
    // For safety in this MVP, let's assume strict onboarding:
    // If user exists in DB, fail.

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingUser) {
      throw new BadRequestException(
        'User with this email already exists in the database',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 2. Create User record — ID intentionally synced to Firebase UID
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
          email: dto.ownerEmail, // School email defaults to owner email
          address: dto.address,
          phone: dto.phone,
          // Bank details provided during onboarding
          bankName: dto.bankName,
          accountName: dto.accountName,
          accountNumber: dto.accountNumber,
          ownerId: user.id,
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

  /** Get all first payments waiting to be settled */
  async getPendingFirstPayments(includeReceiptSignedUrls = false) {
    const payments = await this.prisma.payment.findMany({
      where: {
        paymentType: PaymentType.FIRST_PAYMENT,
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: false,
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

    const results = await Promise.all(
      payments.map(async (p) => {
        let receiptSignedUrl: string | null = null;
        if (includeReceiptSignedUrls && p.receiptUrl) {
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
          studentName: p.enrollment?.child?.fullName,
          childName: p.enrollment?.child?.fullName, // Alias
          schoolName: p.enrollment?.school?.name,
          className: p.enrollment?.className,
          amount: p.amountPaid, // Alias
          date: p.paymentDate, // Alias
          type: p.paymentType, // Alias
          receiptSignedUrl,
        };
      }),
    );

    return results;
  }

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

    await this.prisma.$transaction(async (tx) => {
      // 1️⃣ Mark payment as confirmed
      await tx.payment.update({
        where: { id: payment.id },
        data: { isConfirmed: true, status: PaymentTransactionStatus.SUCCESS },
      });

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
          message: `Your first payment of ₦${payment.amountPaid} has been confirmed. Enrollment is active.`,
          link: `/parent/enrollments/${enrollment.id}`,
        },
      });
    });

    return {
      message: 'Payment settled and enrollment activated successfully',
      paymentId: payment.id,
    };
  }

  /** Get all pending installment payments across all schools (read-only) */
  async getPendingInstallments() {
    const payments = await this.prisma.payment.findMany({
      where: {
        paymentType: PaymentType.INSTALLMENT,
        isConfirmed: false,
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

    await this.prisma.$transaction(async (tx) => {
      // 1️⃣ Mark payment as failed (not confirmed)
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentTransactionStatus.FAILED,
        },
      });

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
    });

    return {
      message: 'First payment rejected and enrollment marked as failed',
      paymentId: payment.id,
    };
  }

  /** Get students/enrollments for a specific school (admin view) */
  async getSchoolStudents(
    schoolId: string,
    className?: string,
    search?: string,
    page = 1,
    limit = 50,
  ) {
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

    const [enrollments, total] = await Promise.all([
      this.prisma.childEnrollment.findMany({
        where: whereClause,
        include: {
          child: { include: { parent: { include: { user: true } } } },
          payments: { orderBy: { paymentDate: 'desc' } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.childEnrollment.count({ where: whereClause }),
    ]);

    const items = enrollments.map((enrollment) => {
      const confirmedPayments = enrollment.payments.filter(
        (p) => p.isConfirmed,
      );
      const paidAmount = confirmedPayments.reduce(
        (sum, p) => sum + p.amountPaid,
        0,
      );

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
        nextDueDate = enrollment.termStartDate;
      }

      return {
        id: enrollment.childId,
        studentName: enrollment.child.fullName,
        childName: enrollment.child.fullName,
        className: enrollment.className,
        parentName: enrollment.child.parent.user.fullName || 'Unknown',
        totalFee: enrollment.totalSchoolFee,
        paidAmount: paidAmount,
        paymentStatus: enrollment.paymentStatus,
        nextDueDate: nextDueDate
          ? nextDueDate.toISOString().split('T')[0]
          : null,
        avatarUrl: null,
      };
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Platform revenue summary */
  async getPlatformRevenue() {
    const result = await this.prisma.payment.aggregate({
      where: {
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: true,
      },
      _sum: {
        platformAmount: true,
      },
    });

    return {
      totalRevenue: result._sum.platformAmount ?? 0,
    };
  }

  /** Global transactions for admin dashboard */
  async getTransactions(
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
  ) {
    const whereClause: Prisma.PaymentWhereInput = {};
    if (receiptType !== 'ALL') {
      whereClause.paymentType = receiptType as Prisma.EnumPaymentTypeFilter;
    }

    const payments = await this.prisma.payment.findMany({
      where: whereClause,
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

    const results = await Promise.all(
      payments.map(async (p) => {
        let receiptSignedUrl: string | null = null;
        if (includeReceiptSignedUrls && p.receiptUrl) {
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
          amount: p.amountPaid,
          date: p.paymentDate,
          type: p.paymentType,
          studentName: p.enrollment?.child?.fullName,
          childName: p.enrollment?.child?.fullName,
          schoolName: p.enrollment?.school?.name,
          className: p.enrollment?.className,
          platformFeeAmount: p.platformAmount,
          platformFeePercentage: 0.025,
          receiptSignedUrl,
        };
      }),
    );

    return results;
  }

  /** Global student summary for admin dashboard */
  async getStudentsSummary() {
    const [
      totalStudents,
      activeStudents,
      pendingFirstPayments,
      defaultedStudents,
      outstandingBalance,
    ] = await Promise.all([
      this.prisma.childEnrollment.count(),
      this.prisma.childEnrollment.count({
        where: { paymentStatus: PaymentStatus.ACTIVE },
      }),
      this.prisma.payment.count({
        where: {
          paymentType: PaymentType.FIRST_PAYMENT,
          receiver: PaymentReceiver.PLATFORM,
          isConfirmed: false,
          status: PaymentTransactionStatus.PENDING,
        },
      }),
      this.prisma.childEnrollment.count({
        where: { paymentStatus: PaymentStatus.DEFAULTED },
      }),
      this.prisma.childEnrollment.aggregate({
        where: {
          paymentStatus: {
            in: [
              PaymentStatus.PENDING,
              PaymentStatus.ACTIVE,
              PaymentStatus.DEFAULTED,
            ],
          },
        },
        _sum: { remainingBalance: true },
      }),
    ]);

    return {
      totalStudents,
      activeStudents,
      pendingFirstPayments,
      defaultedStudents,
      totalOutstandingBalance: outstandingBalance._sum.remainingBalance ?? 0,
    };
  }

  /** Optional: per-school summary */
  async getSchoolsSummary() {
    const schools = await this.prisma.school.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const enrollmentCounts = await this.prisma.childEnrollment.groupBy({
      by: ['schoolId'],
      _count: { _all: true },
    });

    const pendingAmounts = await this.prisma.payment.groupBy({
      by: ['schoolId'],
      where: { isConfirmed: false },
      _sum: { amountPaid: true },
    });

    const collectedAmounts = await this.prisma.payment.groupBy({
      by: ['schoolId'],
      where: { isConfirmed: true },
      _sum: { schoolAmount: true },
    });

    const enrollmentMap = new Map(
      enrollmentCounts.map((e) => [e.schoolId, e._count._all]),
    );
    const pendingMap = new Map(
      pendingAmounts.map((p) => [p.schoolId, p._sum.amountPaid ?? 0]),
    );
    const collectedMap = new Map(
      collectedAmounts.map((c) => [c.schoolId, c._sum.schoolAmount ?? 0]),
    );

    return schools.map((s) => ({
      schoolId: s.id,
      schoolName: s.name,
      totalStudents: enrollmentMap.get(s.id) ?? 0,
      pendingAmount: pendingMap.get(s.id) ?? 0,
      collectedAmount: collectedMap.get(s.id) ?? 0,
    }));
  }

  /** One-call admin overview */
  async getOverview() {
    const [revenue, studentsSummary, recentTransactions] = await Promise.all([
      this.getPlatformRevenue(),
      this.getStudentsSummary(),
      this.getTransactions(false, 'ALL'),
    ]);

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const paymentsForSeries = await this.prisma.payment.findMany({
      where: {
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: true,
        paymentDate: { gte: start },
      },
      select: { paymentDate: true, platformAmount: true },
      orderBy: { paymentDate: 'asc' },
    });

    const months: { key: string; label: string; value: number }[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleString('en-US', { month: 'short' });
      months.push({ key, label, value: 0 });
    }

    const monthMap = new Map(months.map((m) => [m.key, m]));
    for (const p of paymentsForSeries) {
      const d = new Date(p.paymentDate);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const bucket = monthMap.get(key);
      if (bucket) {
        bucket.value += p.platformAmount ?? 0;
      }
    }

    return {
      totalRevenue: revenue.totalRevenue,
      totalStudents: studentsSummary.totalStudents,
      activeStudents: studentsSummary.activeStudents,
      pendingApprovals: studentsSummary.pendingFirstPayments,
      totalOutstandingBalance: studentsSummary.totalOutstandingBalance,
      recentTransactions: recentTransactions.slice(0, 10),
      revenueSeries: months.map(({ label, value }) => ({ label, value })),
    };
  }
}
