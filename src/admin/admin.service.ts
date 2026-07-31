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
import { computeArrears } from '../common/arrears';
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

  /**
   * Enrollments with their confirmed-installment counts, for arrears derivation.
   *
   * Two queries rather than a filtered relation count: the count is fetched as a
   * single groupBy and joined in memory, so this stays one round trip per shape
   * instead of one per enrollment.
   *
   * `openOnly` restricts to plans that still owe money — used for the
   * platform-wide money aggregate, which must not materialise settled history.
   * The per-school view passes false so the Students tab can list every student,
   * settled ones included.
   */
  private async enrollmentsWithPaidCounts(schoolId?: string, openOnly = true) {
    const where: Prisma.ChildEnrollmentWhereInput = {
      ...(openOnly
        ? {
            remainingBalance: { gt: 0 },
            paymentStatus: {
              in: [
                PaymentStatus.PENDING,
                PaymentStatus.ACTIVE,
                PaymentStatus.DEFAULTED,
              ],
            },
          }
        : {}),
      ...(schoolId ? { schoolId } : {}),
    };

    const enrollments = await this.prisma.childEnrollment.findMany({
      where,
      select: {
        id: true,
        childId: true,
        schoolId: true,
        className: true,
        totalSchoolFee: true,
        remainingBalance: true,
        paymentStatus: true,
        installmentFrequency: true,
        termStartDate: true,
        termEndDate: true,
        child: {
          select: {
            fullName: true,
            parent: { select: { user: { select: { fullName: true } } } },
          },
        },
        school: { select: { id: true, name: true } },
      },
    });

    if (enrollments.length === 0) return [];

    const paidCounts = await this.prisma.payment.groupBy({
      by: ['enrollmentId'],
      where: {
        enrollmentId: { in: enrollments.map((e) => e.id) },
        paymentType: PaymentType.INSTALLMENT,
        isConfirmed: true,
      },
      _count: { _all: true },
    });

    const paidMap = new Map(
      paidCounts.map((p) => [p.enrollmentId, p._count._all]),
    );

    return enrollments.map((e) => ({
      enrollment: e,
      paidInstallments: paidMap.get(e.id) ?? 0,
    }));
  }

  /**
   * Platform-wide collections breakdown, split per school (cached, short TTL).
   *
   * Backs all three tabs of the admin breakdown screen from one payload, because
   * they are three readings of the same rows and the dashboard's old single
   * "Plan Arrears" figure conflated the first two:
   *   - `outstanding` — everything still uncollected, on schedule or not.
   *   - `overdue`     — only what is past due against each plan's schedule.
   *   - `totalStudents` — every enrollment, settled ones included.
   * See `common/arrears.ts` for the overdue derivation.
   */
  async getBreakdownSummary() {
    return this.cache.getOrSet(
      CacheKeys.adminBreakdownSummary(),
      AdminService.AGGREGATE_TTL_SECONDS,
      () => this.computeBreakdownSummary(),
    );
  }

  private async computeBreakdownSummary() {
    // Enrollment totals come from a groupBy (indexed, cheap) so the expensive
    // materialisation below is limited to plans that still owe money.
    const [rows, enrollmentCounts] = await Promise.all([
      this.enrollmentsWithPaidCounts(),
      this.prisma.childEnrollment.groupBy({
        by: ['schoolId'],
        _count: { _all: true },
      }),
    ]);

    const now = new Date();
    const totalsMap = new Map(
      enrollmentCounts.map((e) => [e.schoolId, e._count._all]),
    );

    interface Bucket {
      schoolId: string;
      schoolName: string;
      outstandingKobo: number;
      overdueKobo: number;
      studentsWithBalance: number;
      overdueStudentCount: number;
    }
    const bySchool = new Map<string, Bucket>();

    let outstandingKobo = 0;
    let overdueKobo = 0;
    let overdueStudents = 0;

    for (const { enrollment, paidInstallments } of rows) {
      const arrears = computeArrears(
        {
          remainingBalance: enrollment.remainingBalance,
          installmentFrequency: enrollment.installmentFrequency,
          termStartDate: enrollment.termStartDate,
          termEndDate: enrollment.termEndDate,
          paidInstallments,
        },
        now,
      );

      outstandingKobo += enrollment.remainingBalance;
      overdueKobo += arrears.overdueAmount;
      if (arrears.overdueAmount > 0) overdueStudents += 1;

      const key = enrollment.schoolId;
      const bucket: Bucket = bySchool.get(key) ?? {
        schoolId: key,
        schoolName: enrollment.school?.name ?? 'Unknown School',
        outstandingKobo: 0,
        overdueKobo: 0,
        studentsWithBalance: 0,
        overdueStudentCount: 0,
      };
      bucket.outstandingKobo += enrollment.remainingBalance;
      bucket.overdueKobo += arrears.overdueAmount;
      bucket.studentsWithBalance += 1;
      if (arrears.overdueAmount > 0) bucket.overdueStudentCount += 1;
      bySchool.set(key, bucket);
    }

    // Schools with enrollments but nothing owed still belong on the Students tab,
    // so seed them from the enrollment counts rather than only from open plans.
    const missingIds = enrollmentCounts
      .map((e) => e.schoolId)
      .filter((id) => !bySchool.has(id));
    if (missingIds.length > 0) {
      const extra = await this.prisma.school.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, name: true },
      });
      for (const s of extra) {
        bySchool.set(s.id, {
          schoolId: s.id,
          schoolName: s.name,
          outstandingKobo: 0,
          overdueKobo: 0,
          studentsWithBalance: 0,
          overdueStudentCount: 0,
        });
      }
    }

    const schools = Array.from(bySchool.values()).map((s) => ({
      schoolId: s.schoolId,
      schoolName: s.schoolName,
      totalStudents: totalsMap.get(s.schoolId) ?? 0,
      studentsWithBalance: s.studentsWithBalance,
      outstanding: Money.fromKobo(s.outstandingKobo).toNaira(),
      overdue: Money.fromKobo(s.overdueKobo).toNaira(),
      overdueStudentCount: s.overdueStudentCount,
    }));

    return {
      totalOutstanding: Money.fromKobo(outstandingKobo).toNaira(),
      totalOverdue: Money.fromKobo(overdueKobo).toNaira(),
      totalStudents: enrollmentCounts.reduce(
        (sum, e) => sum + e._count._all,
        0,
      ),
      studentsWithBalance: rows.length,
      overdueStudents,
      overdueSchools: schools.filter((s) => s.overdue > 0).length,
      schools,
    };
  }

  /**
   * Per-student breakdown for one school (paginated), for a single tab.
   *
   * The tab is applied server-side rather than filtered in the client: `overdue`
   * and `outstanding` rank on derived figures that no column holds, so filtering
   * after pagination would page over the wrong set. Sorting and slicing are
   * bounded by one school's enrollments.
   */
  async getSchoolBreakdown(
    schoolId: string,
    tab: 'students' | 'outstanding' | 'overdue' = 'students',
    page?: string | number,
    limit?: string | number,
  ) {
    const { page: p, limit: l, skip } = parsePagination(page, limit);

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });
    if (!school) throw new NotFoundException('School not found');

    // The Students tab lists everyone; the money tabs only need open plans.
    const rows = await this.enrollmentsWithPaidCounts(
      schoolId,
      tab !== 'students',
    );
    const now = new Date();

    const computed = rows.map(({ enrollment, paidInstallments }) => {
      const arrears = computeArrears(
        {
          remainingBalance: enrollment.remainingBalance,
          installmentFrequency: enrollment.installmentFrequency,
          termStartDate: enrollment.termStartDate,
          termEndDate: enrollment.termEndDate,
          paidInstallments,
        },
        now,
      );

      return {
        childId: enrollment.childId,
        studentName: enrollment.child?.fullName ?? 'Unknown Student',
        className: enrollment.className,
        parentName: enrollment.child?.parent?.user?.fullName ?? 'Unknown',
        paymentStatus: enrollment.paymentStatus,
        totalFee: Money.fromKobo(enrollment.totalSchoolFee).toNaira(),
        outstanding: Money.fromKobo(enrollment.remainingBalance).toNaira(),
        overdue: Money.fromKobo(arrears.overdueAmount).toNaira(),
        paidInstallments,
        missedInstallments: arrears.missedInstallments,
        daysOverdue: arrears.daysOverdue,
        termExpired: arrears.termExpired,
        nextDueDate: arrears.nextDueDate
          ? arrears.nextDueDate.toISOString().split('T')[0]
          : null,
        installmentFrequency: enrollment.installmentFrequency,
      };
    });

    // Worst-first on the tab's own metric — an admin opens this to find who to
    // chase, so the ordering has to match the column being read.
    const filtered =
      tab === 'overdue' ? computed.filter((r) => r.overdue > 0) : computed;

    filtered.sort((a, b) => {
      if (tab === 'overdue') {
        return (
          b.overdue - a.overdue ||
          b.daysOverdue - a.daysOverdue ||
          b.outstanding - a.outstanding
        );
      }
      if (tab === 'outstanding') {
        return b.outstanding - a.outstanding || b.overdue - a.overdue;
      }
      return a.studentName.localeCompare(b.studentName);
    });

    return {
      ...paginate(filtered.slice(skip, skip + l), filtered.length, p, l),
      schoolId,
      schoolName: school.name,
      tab,
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

  /** Buckets the dashboard revenue chart supports. */
  private static readonly SERIES_MONTHS = 6;
  private static readonly SERIES_WEEKS = 8;

  /**
   * Confirmed platform fees bucketed by month or ISO-ish week.
   *
   * The client used to bucket this itself from whatever transaction page it held,
   * and had no weekly data at all — its "Weekly" toggle silently re-rendered the
   * monthly series. Both ranges are now derived here from the ledger.
   */
  private async revenueSeries(range: 'monthly' | 'weekly') {
    const now = new Date();
    const buckets: { key: string; label: string; value: number }[] = [];

    // Bucket boundaries are computed once, in local server time, so the
    // grouping key derived per payment below lands in exactly one bucket.
    const keyFor =
      range === 'monthly'
        ? (d: Date) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        : (d: Date) => {
            const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            // Snap to the Monday that starts this week.
            const offset = (day.getDay() + 6) % 7;
            day.setDate(day.getDate() - offset);
            return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
          };

    let start: Date;
    if (range === 'monthly') {
      start = new Date(
        now.getFullYear(),
        now.getMonth() - (AdminService.SERIES_MONTHS - 1),
        1,
      );
      for (let i = AdminService.SERIES_MONTHS - 1; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        buckets.push({
          key: keyFor(d),
          label: d.toLocaleString('en-US', { month: 'short' }),
          value: 0,
        });
      }
    } else {
      const thisMonday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - ((now.getDay() + 6) % 7),
      );
      start = new Date(thisMonday);
      start.setDate(start.getDate() - 7 * (AdminService.SERIES_WEEKS - 1));
      for (let i = AdminService.SERIES_WEEKS - 1; i >= 0; i -= 1) {
        const d = new Date(thisMonday);
        d.setDate(d.getDate() - 7 * i);
        buckets.push({
          key: keyFor(d),
          label: `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`,
          value: 0,
        });
      }
    }

    const payments = await this.prisma.payment.findMany({
      where: {
        receiver: PaymentReceiver.PLATFORM,
        isConfirmed: true,
        paymentDate: { gte: start },
      },
      select: { paymentDate: true, platformAmount: true },
      orderBy: { paymentDate: 'asc' },
    });

    const bucketMap = new Map(buckets.map((b) => [b.key, b]));
    for (const p of payments) {
      const bucket = bucketMap.get(keyFor(new Date(p.paymentDate)));
      if (bucket) {
        bucket.value += Money.fromKobo(p.platformAmount ?? 0).toNaira();
      }
    }

    return buckets.map(({ label, value }) => ({ label, value }));
  }

  /** One-call admin overview */
  async getOverview(range: 'monthly' | 'weekly' = 'monthly') {
    const [revenue, studentsSummary, recentTransactions, revenueSeries] =
      await Promise.all([
        this.getPlatformRevenue(),
        this.getStudentsSummary(),
        this.recentTransactions(10),
        this.revenueSeries(range),
      ]);

    return {
      totalRevenue: revenue.totalRevenue,
      totalStudents: studentsSummary.totalStudents,
      activeStudents: studentsSummary.activeStudents,
      pendingApprovals: studentsSummary.pendingFirstPayments,
      totalOutstandingBalance: studentsSummary.totalOutstandingBalance,
      recentTransactions,
      revenueSeries,
    };
  }
}
