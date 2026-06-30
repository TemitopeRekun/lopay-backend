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
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateSchoolDto } from './dto/create.school.dto';
import { DocumentsService } from '../documents/documents.service';
import { AuditService, AuditActor } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { SchoolOnboardingService } from '../school-onboarding/school-onboarding.service';
import { Money } from '../common/money';
import { PLATFORM_FEE_RATE } from '../common/fees';
import { errorMessage } from '../common/errors';
import { paymentCommonFields } from '../common/payment-dto';
import { PaystackService } from '../paystack/paystack.service';
import {
  parsePagination,
  paginate,
  type Paginated,
} from '../common/pagination';
import { CacheService, CacheKeys } from '../cache/cache.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly documentsService: DocumentsService,
    private readonly audit: AuditService,
    private readonly paystack: PaystackService,
    private readonly ledger: LedgerService,
    private readonly onboarding: SchoolOnboardingService,
    private readonly cache: CacheService,
  ) {}

  // Short TTL for dashboard aggregates — they tolerate seconds of staleness and
  // are re-derived cheaply; no explicit invalidation needed (M4 scale).
  private static readonly AGGREGATE_TTL_SECONDS = 30;
  private static readonly BANKS_TTL_SECONDS = 24 * 60 * 60;

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
      return {
        active: false,
        warning: 'No bank code on file; cannot create Paystack subaccount.',
      };
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
        data: {
          paystackSubaccountCode: subaccountCode,
          paystackSubaccountActive: true,
        },
      });
      return { active: true, subaccountCode };
    } catch (error) {
      this.logger.error(
        `Paystack subaccount creation failed for school ${school.id}: ${errorMessage(error)}`,
      );
      return {
        active: false,
        warning:
          'School created, but Paystack subaccount setup failed. Retry from the school settings before accepting online payments.',
      };
    }
  }

  /** Nigerian bank list for the onboarding dropdown (cached ~24h, shared). */
  async listBanks() {
    return this.cache.getOrSet(
      CacheKeys.paystackBanks(),
      AdminService.BANKS_TTL_SECONDS,
      () => this.paystack.listBanks(),
    );
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
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });
    if (!school) throw new NotFoundException('School not found');
    const result = await this.provisionSubaccount(school);
    if (!result.active) {
      throw new BadRequestException(
        result.warning ?? 'Subaccount creation failed',
      );
    }
    return { subaccountCode: result.subaccountCode, active: true };
  }

  /** Onboard a new school and create the school owner account */
  async onboardSchool(dto: CreateSchoolDto) {
    // Shared provisioning saga (owner + school, with owner rollback on failure).
    const { school, user } = await this.onboarding.provisionSchoolAndOwner(dto);

    // Provision the Paystack subaccount (external call, post-transaction).
    // Best-effort: onboarding succeeds even if this fails; retry via admin endpoint.
    const subaccount = await this.provisionSubaccount(school);

    return {
      school: {
        ...school,
        paystackSubaccountActive: subaccount.active,
      },
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
      },
      paystack: subaccount,
      message: subaccount.active
        ? 'School and School Owner created successfully'
        : `School created. ${subaccount.warning}`,
    };
  }

  /** Get first payments waiting to be settled (paginated). */
  async getPendingFirstPayments(
    includeReceiptSignedUrls = false,
    page?: string | number,
    limit?: string | number,
  ): Promise<Paginated<unknown>> {
    const { page: p, limit: l, skip } = parsePagination(page, limit);
    const where = {
      paymentType: PaymentType.FIRST_PAYMENT,
      receiver: PaymentReceiver.PLATFORM,
      isConfirmed: false,
      status: PaymentTransactionStatus.PENDING,
    } satisfies Prisma.PaymentWhereInput;

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: { enrollment: { include: { child: true, school: true } } },
        orderBy: { paymentDate: 'desc' },
        skip,
        take: l,
      }),
      this.prisma.payment.count({ where }),
    ]);

    // Signing fans out at most `l` (<= MAX_PAGE_SIZE) URLs — bounded to this page.
    const items = await Promise.all(
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

    return paginate(items, total, p, l);
  }

  /** Thin caller — settle logic lives in LedgerService (Milestone 3). */
  async settleFirstPayment(paymentId: string, actor: AuditActor) {
    return this.ledger.settleFirstPayment(paymentId, actor);
  }

  /** Get pending installment payments across all schools (paginated, read-only). */
  async getPendingInstallments(
    page?: string | number,
    limit?: string | number,
  ): Promise<Paginated<unknown>> {
    const { page: p, limit: l, skip } = parsePagination(page, limit);
    const where = {
      paymentType: PaymentType.INSTALLMENT,
      isConfirmed: false,
      status: PaymentTransactionStatus.PENDING,
    } satisfies Prisma.PaymentWhereInput;

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: { enrollment: { include: { child: true, school: true } } },
        orderBy: { paymentDate: 'desc' },
        skip,
        take: l,
      }),
      this.prisma.payment.count({ where }),
    ]);

    const items = payments.map((p) => ({
      ...p,
      date: p.paymentDate,
      amount: Money.fromKobo(p.amountPaid).toNaira(),
      amountPaid: Money.fromKobo(p.amountPaid).toNaira(),
      studentName: p.enrollment?.child?.fullName,
      childName: p.enrollment?.child?.fullName,
      className: p.enrollment?.className,
      schoolName: p.enrollment?.school?.name,
    }));

    return paginate(items, total, p, l);
  }

  /** Thin caller — reject logic lives in LedgerService (Milestone 3). */
  async rejectFirstPayment(paymentId: string, actor: AuditActor) {
    return this.ledger.rejectFirstPayment(paymentId, actor);
  }

  /** Get students/enrollments for a specific school (admin view, paginated). */
  async getSchoolStudents(
    schoolId: string,
    className?: string,
    search?: string,
    page?: string | number,
    limit?: string | number,
  ) {
    const { page: p, limit: l, skip } = parsePagination(page, limit);
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
        skip,
        take: l,
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

    return paginate(items, total, p, l);
  }

  /** Platform revenue summary (cached, short TTL). */
  async getPlatformRevenue() {
    return this.cache.getOrSet(
      CacheKeys.adminRevenue(),
      AdminService.AGGREGATE_TTL_SECONDS,
      async () => {
        const result = await this.prisma.payment.aggregate({
          where: { receiver: PaymentReceiver.PLATFORM, isConfirmed: true },
          _sum: { platformAmount: true },
        });
        return {
          totalRevenue: Money.fromKobo(
            result._sum.platformAmount ?? 0,
          ).toNaira(),
        };
      },
    );
  }

  /** Global transactions for the admin dashboard (paginated). */
  async getTransactions(
    includeReceiptSignedUrls = false,
    receiptType: 'ALL' | 'FIRST_PAYMENT' | 'INSTALLMENT' = 'ALL',
    page?: string | number,
    limit?: string | number,
  ): Promise<Paginated<unknown>> {
    const { page: p, limit: l, skip } = parsePagination(page, limit);
    const where: Prisma.PaymentWhereInput = {};
    if (receiptType !== 'ALL') {
      where.paymentType = receiptType as Prisma.EnumPaymentTypeFilter;
    }

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: { enrollment: { include: { child: true, school: true } } },
        orderBy: { paymentDate: 'desc' },
        skip,
        take: l,
      }),
      this.prisma.payment.count({ where }),
    ]);

    // Sign at most one page of receipts — the fan-out is bounded by `l`.
    const items = await Promise.all(
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
        return { ...this.mapTransaction(p), receiptSignedUrl };
      }),
    );

    return paginate(items, total, p, l);
  }

  /** Shape a payment row into the admin transaction view (no signed URL). */
  private mapTransaction(
    p: Prisma.PaymentGetPayload<{
      include: { enrollment: { include: { child: true; school: true } } };
    }>,
  ) {
    return {
      ...p,
      ...paymentCommonFields(p),
      date: p.paymentDate,
      type: p.paymentType,
      childName: p.enrollment?.child?.fullName,
      platformFeeAmount: Money.fromKobo(p.platformAmount).toNaira(),
      platformFeePercentage: PLATFORM_FEE_RATE,
    };
  }

  /**
   * The N most-recent transactions for the dashboard. A dedicated `take`-bounded
   * query — never materialises the full table the way slicing getTransactions did.
   */
  private async recentTransactions(take: number) {
    const payments = await this.prisma.payment.findMany({
      include: { enrollment: { include: { child: true, school: true } } },
      orderBy: { paymentDate: 'desc' },
      take,
    });
    return payments.map((p) => ({
      ...this.mapTransaction(p),
      receiptSignedUrl: null,
    }));
  }

  /** Global student summary for admin dashboard (cached, short TTL). */
  async getStudentsSummary() {
    return this.cache.getOrSet(
      CacheKeys.adminStudentsSummary(),
      AdminService.AGGREGATE_TTL_SECONDS,
      () => this.computeStudentsSummary(),
    );
  }

  private async computeStudentsSummary() {
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
      totalOutstandingBalance: Money.fromKobo(
        outstandingBalance._sum.remainingBalance ?? 0,
      ).toNaira(),
    };
  }

  /** Per-school summary (cached, short TTL). */
  async getSchoolsSummary() {
    return this.cache.getOrSet(
      CacheKeys.adminSchoolsSummary(),
      AdminService.AGGREGATE_TTL_SECONDS,
      () => this.computeSchoolsSummary(),
    );
  }

  private async computeSchoolsSummary() {
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
      this.recentTransactions(10),
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
      recentTransactions,
      revenueSeries: months.map(({ label, value }) => ({ label, value })),
    };
  }
}
