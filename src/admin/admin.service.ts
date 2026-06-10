import {
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
import { AuthService } from '@thallesp/nestjs-better-auth';
import { CreateSchoolDto } from './dto/create.school.dto';
import { DocumentsService } from '../documents/documents.service';
import { AuditService, AuditActor } from '../audit/audit.service';
import { Money } from '../common/money';
import { PaystackService } from '../paystack/paystack.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly documentsService: DocumentsService,
    private readonly audit: AuditService,
    private readonly paystack: PaystackService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Create (or recreate) a Paystack subaccount for a school and persist the code.
   * Best-effort: returns active=false if Paystack is unreachable so onboarding
   * still succeeds and can be retried via the admin endpoint.
   */
  private async provisionSubaccount(school: {
    id: string;
    name: string;
    bankCode: string | null;
    accountNumber: string;
  }): Promise<{ active: boolean; subaccountCode?: string; warning?: string }> {
    if (!school.bankCode) {
      return { active: false, warning: 'No bank code on file; cannot create Paystack subaccount.' };
    }
    try {
      const subaccountCode = await this.paystack.createSubaccount({
        businessName: school.name,
        settlementBank: school.bankCode,
        accountNumber: school.accountNumber,
        percentageCharge: 0, // overridden per-transaction via transaction_charge
      });
      await this.prisma.school.update({
        where: { id: school.id },
        data: { paystackSubaccountCode: subaccountCode, paystackSubaccountActive: true },
      });
      return { active: true, subaccountCode };
    } catch (error) {
      this.logger.error(
        `Paystack subaccount creation failed for school ${school.id}`,
        error as any,
      );
      return {
        active: false,
        warning:
          'School created, but Paystack subaccount setup failed. Retry from the school settings before accepting online payments.',
      };
    }
  }

  /** Passthrough: Nigerian bank list for the onboarding dropdown. */
  async listBanks() {
    return this.paystack.listBanks();
  }

  /** Passthrough: resolve an account number → registered account name. */
  async resolveAccount(accountNumber: string, bankCode: string) {
    if (!accountNumber || !bankCode) {
      throw new BadRequestException('accountNumber and bankCode are required');
    }
    return this.paystack.resolveAccount(accountNumber, bankCode);
  }

  /** Admin action: (re)create a Paystack subaccount for an existing school. */
  async createSubaccountForSchool(schoolId: string) {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) throw new NotFoundException('School not found');
    const result = await this.provisionSubaccount(school);
    if (!result.active) {
      throw new BadRequestException(result.warning ?? 'Subaccount creation failed');
    }
    return { subaccountCode: result.subaccountCode, active: true };
  }

  /** Onboard a new school and create the school owner account */
  async onboardSchool(dto: CreateSchoolDto) {
    // Fail fast if the owner already has an account.
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingUser) {
      throw new BadRequestException(
        'User with this email already exists in the database',
      );
    }

    // 1. Create the owner via Better Auth (creates the User + credential Account).
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
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.logger.error(`Owner account creation failed: ${err.message}`);
      throw new BadRequestException(
        `Could not create owner account: ${err.message ?? 'unknown error'}`,
      );
    }

    // 2. Create the School row linked to the new owner. Better Auth created the
    // User outside this transaction, so compensate by deleting it on failure.
    let created;
    try {
      const school = await this.prisma.school.create({
        data: {
          name: dto.schoolName,
          email: dto.ownerEmail,
          address: dto.address,
          phone: dto.phone,
          bankName: dto.bankName,
          bankCode: dto.bankCode,
          accountName: dto.accountName,
          accountNumber: dto.accountNumber,
          ownerId: ownerUserId,
        },
      });
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
      });
      created = { school, user };
    } catch (error) {
      // Roll back the orphaned auth user (cascades to session/account).
      await this.prisma.user
        .delete({ where: { id: ownerUserId } })
        .catch(() => undefined);
      throw error;
    }

    // 4. Provision the Paystack subaccount (external call, post-transaction).
    // Best-effort: onboarding succeeds even if this fails; retry via admin endpoint.
    const subaccount = await this.provisionSubaccount(created.school);

    return {
      school: { ...created.school, paystackSubaccountActive: subaccount.active },
      user: {
        id: created.user.id,
        email: created.user.email,
        role: created.user.role,
        fullName: created.user.fullName,
      },
      paystack: subaccount,
      message: subaccount.active
        ? 'School and School Owner created successfully'
        : `School created. ${subaccount.warning}`,
    };
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
          childName: p.enrollment?.child?.fullName,
          schoolName: p.enrollment?.school?.name,
          className: p.enrollment?.className,
          amount: Money.fromKobo(p.amountPaid).toNaira(),
          amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
          date: p.paymentDate,
          type: p.paymentType,
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
      amount: Money.fromKobo(p.amountPaid).toNaira(),
      amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
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
      throw new NotFoundException('First payment not found or already processed');
    }

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
        totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
        paidAmount: Money.fromKobo(paidAmount).toNaira(),
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
      totalRevenue: Money.fromKobo(result._sum.platformAmount ?? 0).toNaira(),
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
          amount: Money.fromKobo(p.amountPaid).toNaira(),
          amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
          date: p.paymentDate,
          type: p.paymentType,
          studentName: p.enrollment?.child?.fullName,
          childName: p.enrollment?.child?.fullName,
          schoolName: p.enrollment?.school?.name,
          className: p.enrollment?.className,
          platformFeeAmount: Money.fromKobo(p.platformAmount).toNaira(),
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
      totalOutstandingBalance: Money.fromKobo(outstandingBalance._sum.remainingBalance ?? 0).toNaira(),
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
      pendingAmount: Money.fromKobo(pendingMap.get(s.id) ?? 0).toNaira(),
      collectedAmount: Money.fromKobo(collectedMap.get(s.id) ?? 0).toNaira(),
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
        bucket.value += Money.fromKobo(p.platformAmount ?? 0).toNaira();
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
